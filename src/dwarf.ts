/**
 * DWARF layer — bidirectional clause↔code mapping (DECISIONS D4, VISION P3).
 *
 * - `recordMapping` accepts a claimed clause→code range and cross-verifies it
 *   against the REAL working-tree diff before persisting: provenance trusts
 *   the diff, never an LLM's self-report.
 * - `detectUnmapped` attributes every diff hunk to a clause mapping, an
 *   explicit ack, or a spec write-back; anything else is `unmapped` — the
 *   enforcement point that flips the source of truth.
 * - `blame` answers "which clauses constrain this line".
 *
 * v0 boundary: ranges anchor to (file, lines, commit_sha) at claim time;
 * line drift from later edits is not re-anchored yet.
 */

import { spawnSync } from 'node:child_process'

import type { Database } from 'better-sqlite3'

export const CODE_MAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS clause_code_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('clause', 'ack')),
  spec_path   TEXT,
  clause_id   TEXT,
  file_path   TEXT    NOT NULL,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL CHECK (line_end >= line_start),
  commit_sha  TEXT    NOT NULL,
  dispatch_id TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  CHECK ((kind = 'clause') = (spec_path IS NOT NULL AND clause_id IS NOT NULL))
);
`

export const ensureCodeMap = (db: Database): void => {
  db.exec(CODE_MAP_SCHEMA)
}

export interface DiffHunk {
  filePath: string
  /** 1-based first line on the NEW side; pure deletions anchor to the line above. */
  lineStart: number
  lineEnd: number
}

export interface MappingClaim {
  specPath: string
  clauseId: string
  filePath: string
  lineStart: number
  lineEnd: number
  note?: string
}

export type MapOutcome =
  | { kind: 'mapped'; id: number; commitSha: string }
  | { kind: 'acked'; id: number; commitSha: string }
  | {
      kind: 'rejected'
      code: 'unknown_clause' | 'unverified_range' | 'git_failed'
      message: string
    }

export interface UnmappedReport {
  hunks: DiffHunk[]
  /** Hunks with no clause mapping, no ack, and not a spec write-back. */
  unmapped: DiffHunk[]
}

export interface BlameEntry {
  specPath: string
  clauseId: string
  lineStart: number
  lineEnd: number
  commitSha: string
  note: string | null
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

const git = (args: string[], cwd: string): { ok: boolean; stdout: string; error: string } => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: '', error: (result.stderr ?? String(result.error)).trim() }
  }
  return { ok: true, stdout: result.stdout ?? '', error: '' }
}

/**
 * Working-tree hunks vs HEAD, new-side line numbers (`--unified=0` so hunk
 * bounds are exact). A pure deletion has zero new-side lines; it anchors to
 * a 1-line range at its position so it still demands attribution.
 */
export const diffHunks = (workspaceRoot: string): { hunks: DiffHunk[] } | { error: string } => {
  const diff = git(['diff', '--unified=0', 'HEAD'], workspaceRoot)
  if (!diff.ok) return { error: `git diff failed: ${diff.error}` }

  const hunks: DiffHunk[] = []
  let currentFile: string | null = null
  for (const line of diff.stdout.split('\n')) {
    const oldFile = line.match(/^--- (?:a\/(.*)|\/dev\/null)$/)
    if (oldFile) {
      currentFile = oldFile[1] ?? null
      continue
    }
    const newFile = line.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/)
    if (newFile) {
      // Deleted files keep the old path; everything else uses the new path.
      if (newFile[1] !== undefined) currentFile = newFile[1]
      continue
    }
    const hunk = line.match(HUNK_HEADER)
    if (!hunk || currentFile === null) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    const anchored = Math.max(start, 1) // a deletion at file start reports +0
    hunks.push({
      filePath: currentFile,
      lineStart: anchored,
      lineEnd: anchored + Math.max(count, 1) - 1,
    })
  }
  return { hunks }
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart <= bEnd && bStart <= aEnd

/** Is the clause declared by the latest live revision of its spec file? */
const clauseIsLive = (db: Database, specPath: string, clauseId: string): boolean => {
  const row = db
    .prepare(
      `SELECT 1 FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       WHERE c.spec_path = ? AND c.clause_id = ?`
    )
    .get(specPath, clauseId)
  return row !== undefined
}

const headSha = (workspaceRoot: string): string | null => {
  const head = git(['rev-parse', 'HEAD'], workspaceRoot)
  return head.ok ? head.stdout.trim() : null
}

/** Shared cross-verification: the claimed range must intersect a real hunk. */
const verifyRange = (
  workspaceRoot: string,
  filePath: string,
  lineStart: number,
  lineEnd: number,
  verb: string
): { sha: string } | { rejected: MapOutcome & { kind: 'rejected' } } => {
  const result = diffHunks(workspaceRoot)
  if ('error' in result) {
    return { rejected: { kind: 'rejected', code: 'git_failed', message: result.error } }
  }
  const touched = result.hunks.some(
    (hunk) =>
      hunk.filePath === filePath && overlaps(hunk.lineStart, hunk.lineEnd, lineStart, lineEnd)
  )
  if (!touched) {
    return {
      rejected: {
        kind: 'rejected',
        code: 'unverified_range',
        message: `${verb} range ${filePath}:${lineStart}-${lineEnd} does not intersect any working-tree change.`,
      },
    }
  }
  const sha = headSha(workspaceRoot)
  if (sha === null) {
    return { rejected: { kind: 'rejected', code: 'git_failed', message: 'git rev-parse HEAD failed' } }
  }
  return { sha }
}

/**
 * Persist a claimed clause→code mapping — only after the claimed range
 * intersects a real diff hunk on that file (D4: trust the diff, not the
 * claim). The mapping records HEAD at claim time.
 */
export const recordMapping = (
  db: Database,
  claim: MappingClaim,
  workspaceRoot: string,
  timestamp: number
): MapOutcome => {
  ensureCodeMap(db)
  if (!clauseIsLive(db, claim.specPath, claim.clauseId)) {
    return {
      kind: 'rejected',
      code: 'unknown_clause',
      message: `No live clause ${claim.specPath}#${claim.clauseId} in the registry — run \`urtext index\` first.`,
    }
  }
  const verified = verifyRange(
    workspaceRoot,
    claim.filePath,
    claim.lineStart,
    claim.lineEnd,
    'Claimed'
  )
  if ('rejected' in verified) return verified.rejected

  const inserted = db
    .prepare(
      `INSERT INTO clause_code_map
         (kind, spec_path, clause_id, file_path, line_start, line_end, commit_sha, note, created_at)
       VALUES ('clause', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      claim.specPath,
      claim.clauseId,
      claim.filePath,
      claim.lineStart,
      claim.lineEnd,
      verified.sha,
      claim.note ?? null,
      timestamp
    )
  return { kind: 'mapped', id: Number(inserted.lastInsertRowid), commitSha: verified.sha }
}

/**
 * Explicit manual ack for a change that intentionally maps to no clause.
 * Same diff cross-verification as a mapping — you can only ack a change
 * that exists. The reason is mandatory: an ack is a visible decision.
 */
export const recordAck = (
  db: Database,
  ack: { filePath: string; lineStart: number; lineEnd: number; note: string },
  workspaceRoot: string,
  timestamp: number
): MapOutcome => {
  ensureCodeMap(db)
  const verified = verifyRange(workspaceRoot, ack.filePath, ack.lineStart, ack.lineEnd, 'Acked')
  if ('rejected' in verified) return verified.rejected

  const inserted = db
    .prepare(
      `INSERT INTO clause_code_map
         (kind, file_path, line_start, line_end, commit_sha, note, created_at)
       VALUES ('ack', ?, ?, ?, ?, ?, ?)`
    )
    .run(ack.filePath, ack.lineStart, ack.lineEnd, verified.sha, ack.note, timestamp)
  return { kind: 'acked', id: Number(inserted.lastInsertRowid), commitSha: verified.sha }
}

interface MappingRow {
  kind: 'clause' | 'ack'
  file_path: string
  line_start: number
  line_end: number
}

/**
 * Attribute every working-tree hunk. A hunk is accounted for when it
 * intersects a clause mapping or ack recorded AT THE CURRENT HEAD (older
 * mappings describe other code states), or when it edits `specs/**` markdown
 * — writing the spec back IS the attribution.
 */
export const detectUnmapped = (
  db: Database,
  workspaceRoot: string
): UnmappedReport | { error: string } => {
  ensureCodeMap(db)
  const result = diffHunks(workspaceRoot)
  if ('error' in result) return { error: result.error }
  const sha = headSha(workspaceRoot)
  if (sha === null) return { error: 'git rev-parse HEAD failed' }

  const rows = db
    .prepare(
      `SELECT kind, file_path, line_start, line_end
       FROM clause_code_map WHERE commit_sha = ?`
    )
    .all(sha) as MappingRow[]

  const isSpecWriteback = (filePath: string): boolean =>
    /^specs\/[^/]+\/[^/]+\.md$/.test(filePath)

  const unmapped = result.hunks.filter((hunk) => {
    if (isSpecWriteback(hunk.filePath)) return false
    return !rows.some(
      (row) =>
        row.file_path === hunk.filePath &&
        overlaps(row.line_start, row.line_end, hunk.lineStart, hunk.lineEnd)
    )
  })
  return { hunks: result.hunks, unmapped }
}

/** Which clauses constrain this line? Reverse lookup over recorded mappings. */
export const blame = (db: Database, filePath: string, line: number): BlameEntry[] => {
  ensureCodeMap(db)
  return db
    .prepare(
      `SELECT spec_path AS specPath, clause_id AS clauseId, line_start AS lineStart,
              line_end AS lineEnd, commit_sha AS commitSha, note
       FROM clause_code_map
       WHERE kind = 'clause' AND file_path = ? AND line_start <= ? AND line_end >= ?
       ORDER BY created_at DESC`
    )
    .all(filePath, line, line) as BlameEntry[]
}
