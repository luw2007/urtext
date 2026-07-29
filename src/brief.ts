/**
 * Decision brief (operator-flow plan P2) — the full adjudication context for
 * one clause in one command. The registry already holds the clause, mapping,
 * evidence, and audit facts; the brief is their deterministic JOIN plus a
 * content hash used as an approval freshness precondition.
 *
 * brief-hash guarantees that an approval references the CURRENT clause text +
 * metadata (oracle/risk/refs — `text_hash` alone covers only title+body),
 * mapped code content, and evidence/audit state. It does NOT prove the human
 * read or understood anything (an agent can compute it too), and it does NOT
 * replace the HEAD binding of reviews/decisions (M5a unchanged; a mapping is
 * navigation, not a safety boundary — D4 intersection is weak provenance).
 *
 * Ready-guard (fail-closed): a clause on a `building`/tombstoned revision, or
 * whose spec file has link errors, gets NO approvable hash.
 *
 * Mapping selection: the newest row per (file, range) for the clause at ANY
 * commit — after the implementation commit the claim-time sha is no longer
 * HEAD, but the ranges still navigate to the code; content is read from the
 * current working tree, so drift between brief and approval changes the hash.
 *
 * Impact closure is display context, deliberately OUTSIDE the hash: a new
 * dependent changes neither what is being approved nor its content.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from 'better-sqlite3'

import { ensureAuditLedger } from './audit.js'
import { ensureCodeMap } from './dwarf.js'
import { impact, linkWorkspace, type ImpactReport } from './linker.js'
import { ensureEvidenceLedger } from './verifier.js'

export interface BriefMapping {
  filePath: string
  lineStart: number
  lineEnd: number
  commitSha: string
  note: string | null
  /** Range content from the CURRENT working tree; null when the file is gone. */
  content: string | null
  /** Patch hunks from the mapping's recorded HEAD to the current working tree. */
  diff: string | null
  /** Git/format failure is distinct from a clean mapped range. */
  diffError: string | null
}

export interface BriefManifest {
  schema: 'urtext.brief/1'
  head: string | null
  specPath: string
  clauseId: string
  title: string
  body: string | null
  oracleKind: string | null
  oracleRef: string | null
  risk: 'low' | 'high'
  refs: string[]
  reqs: string[]
  stale: boolean
  /** Origin key for a stale stamp; absent for fresh and legacy rows. */
  invalidationSource?: string
  evidence: { verdict: string; exitCode: number | null; digest: string } | null
  auditVerdict: 'agree' | 'disagree' | null
  mappings: BriefMapping[]
}

export interface Brief {
  manifest: BriefManifest
  /** 12-hex freshness token quoted back via `--brief <hash>`. */
  briefHash: string
  /** Latest evidence output (full, capped upstream) for display. */
  evidenceOutput: string | null
  impact: ImpactReport
}

export type BriefOutcome =
  | { kind: 'built'; brief: Brief }
  | { kind: 'refused'; code: 'unknown_clause' | 'not_ready' | 'link_error'; message: string }

export interface ClauseTarget {
  specPath: string
  clauseId: string
}

/** Current HEAD sha, or null when not a git repo (same shape as review.ts). */
const currentHead = (workspaceRoot: string): string | null => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout.trim()
}

interface LiveClauseRow {
  revision: number
  status: string
  title: string
  body: string | null
  oracle_kind: string | null
  oracle_ref: string | null
  risk: 'low' | 'high'
  refs: string
  reqs: string
}

const liveClause = (db: Database, target: ClauseTarget): LiveClauseRow | undefined =>
  db
    .prepare(
      `SELECT c.revision, r.status, c.title, c.body, c.oracle_kind, c.oracle_ref, c.risk, c.refs, c.reqs
       FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       JOIN revisions r ON r.spec_path = c.spec_path AND r.revision = c.revision
       WHERE c.spec_path = ? AND c.clause_id = ? AND r.status != 'tombstoned'`
    )
    .get(target.specPath, target.clauseId) as LiveClauseRow | undefined

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

const rangeContent = (
  workspaceRoot: string,
  filePath: string,
  lineStart: number,
  lineEnd: number
): string | null => {
  let file: string
  try {
    file = readFileSync(join(workspaceRoot, filePath), 'utf8')
  } catch {
    return null
  }
  return file.split('\n').slice(lineStart - 1, lineEnd).join('\n')
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart <= bEnd && bStart <= aEnd

/** Diff only one mapped file, then retain hunks intersecting the mapping's
 * new-side range. Mapping ranges are recorded against the working-tree side of
 * the claim-time diff, so the new-side coordinates are the matching contract. */
const mappedDiff = (
  workspaceRoot: string,
  mapping: { filePath: string; lineStart: number; lineEnd: number; commitSha: string }
): { diff: string | null; error: string | null } => {
  const result = spawnSync(
    'git',
    ['diff', '--no-ext-diff', '--unified=3', mapping.commitSha, '--', mapping.filePath],
    { cwd: workspaceRoot, encoding: 'utf8' }
  )
  if (result.error || result.status !== 0) {
    return { diff: null, error: (result.stderr || String(result.error)).trim() || 'git diff failed' }
  }
  const output = result.stdout ?? ''
  if (/^(?:Binary files|GIT binary patch)/m.test(output)) {
    return { diff: null, error: 'binary diff is not supported' }
  }
  if (/^rename (?:from|to) /m.test(output)) {
    return { diff: null, error: 'rename diff cannot be attributed to a recorded line range' }
  }
  const selected: string[] = []
  let current: string[] | null = null
  let intersects = false
  const flush = () => {
    if (current !== null && intersects) selected.push(current.join('\n'))
  }
  for (const line of output.split('\n')) {
    const header = line.match(HUNK_HEADER)
    if (header) {
      flush()
      const rawCount = header[4] === undefined ? 1 : Number(header[4])
      if (rawCount === 0) {
        return { diff: null, error: 'pure deletion diff cannot be attributed to a new-side mapped range' }
      }
      current = [line]
      const start = Math.max(Number(header[3]), 1)
      const count = rawCount
      const end = start + Math.max(count, 1) - 1
      intersects = overlaps(mapping.lineStart, mapping.lineEnd, start, end)
    } else if (current !== null) {
      current.push(line)
    }
  }
  flush()
  return { diff: selected.length > 0 ? selected.join('\n') : null, error: null }
}

export const buildBrief = (db: Database, workspaceRoot: string, target: ClauseTarget): BriefOutcome => {
  ensureEvidenceLedger(db)
  ensureAuditLedger(db)
  ensureCodeMap(db)

  const clause = liveClause(db, target)
  const key = `${target.specPath}#${target.clauseId}`
  if (!clause) {
    return { kind: 'refused', code: 'unknown_clause', message: `No live clause ${key} — run \`urtext index\` first.` }
  }
  if (clause.status !== 'ready') {
    return {
      kind: 'refused',
      code: 'not_ready',
      message: `${target.specPath} is at a '${clause.status}' revision — fix validation errors before adjudicating (no approvable hash for an inactive definition).`,
    }
  }
  const linkErrors = linkWorkspace(db).filter((error) => error.specPath === target.specPath)
  if (linkErrors.length > 0) {
    const codes = [...new Set(linkErrors.map((error) => error.code))].join(', ')
    return {
      kind: 'refused',
      code: 'link_error',
      message: `${target.specPath} has ${linkErrors.length} unresolved link error(s) (${codes}) — fix the reported refs/reqs before adjudicating.`,
    }
  }

  const evidenceRow = db
    .prepare(
      `SELECT id, verdict, exit_code, oracle_ref, output, invalidated_at, invalidation_source
       FROM evidence
       WHERE spec_path = ? AND revision = ? AND clause_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(target.specPath, clause.revision, target.clauseId) as
    | {
        id: number
        verdict: string
        exit_code: number | null
        oracle_ref: string | null
        output: string
        invalidated_at: number | null
        invalidation_source: string | null
      }
    | undefined

  const auditRow = evidenceRow
    ? (db
        .prepare(`SELECT verdict FROM audit_verdicts WHERE evidence_id = ? ORDER BY id DESC LIMIT 1`)
        .get(evidenceRow.id) as { verdict: 'agree' | 'disagree' } | undefined)
    : undefined

  // Newest mapping row per (file, range) for this clause, any commit; sorted
  // for a deterministic manifest.
  const mappingRows = db
    .prepare(
      `SELECT file_path, line_start, line_end, commit_sha, note
       FROM clause_code_map
       WHERE kind = 'clause' AND spec_path = ? AND clause_id = ?
       ORDER BY id DESC`
    )
    .all(target.specPath, target.clauseId) as
    { file_path: string; line_start: number; line_end: number; commit_sha: string; note: string | null }[]
  const seenRanges = new Set<string>()
  const mappings: BriefMapping[] = []
  for (const row of mappingRows) {
    const rangeKey = `${row.file_path}:${row.line_start}-${row.line_end}`
    if (seenRanges.has(rangeKey)) continue
    seenRanges.add(rangeKey)
    const diff = mappedDiff(workspaceRoot, {
      filePath: row.file_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      commitSha: row.commit_sha,
    })
    mappings.push({
      filePath: row.file_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      commitSha: row.commit_sha,
      note: row.note,
      content: rangeContent(workspaceRoot, row.file_path, row.line_start, row.line_end),
      diff: diff.diff,
      diffError: diff.error,
    })
  }
  mappings.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart || a.lineEnd - b.lineEnd
  )

  const refs = (JSON.parse(clause.refs) as { path: string; clauseId: string }[]).map(
    (ref) => `${ref.path}#${ref.clauseId}`
  )
  const reqs = (JSON.parse(clause.reqs) as { path: string | null; reqId: string }[]).map(
    (req) => (req.path === null ? req.reqId : `${req.path}#${req.reqId}`)
  )

  const manifest: BriefManifest = {
    schema: 'urtext.brief/1',
    head: currentHead(workspaceRoot),
    specPath: target.specPath,
    clauseId: target.clauseId,
    title: clause.title,
    body: clause.body,
    oracleKind: clause.oracle_kind,
    oracleRef: clause.oracle_ref,
    risk: clause.risk,
    refs,
    reqs,
    stale: evidenceRow ? evidenceRow.invalidated_at !== null : false,
    ...(evidenceRow !== undefined &&
    evidenceRow.invalidated_at !== null &&
    evidenceRow.invalidation_source !== null
      ? { invalidationSource: evidenceRow.invalidation_source }
      : {}),
    evidence: evidenceRow
      ? {
          verdict: evidenceRow.verdict,
          exitCode: evidenceRow.exit_code,
          // Content-based, so an identical re-verify keeps the hash stable
          // (evidence ids are append-only and would churn it).
          digest: `sha256:${sha256(
            `${evidenceRow.verdict}\n${evidenceRow.exit_code}\n${evidenceRow.output}\n${evidenceRow.oracle_ref ?? ''}`
          )}`,
        }
      : null,
    auditVerdict: auditRow?.verdict ?? null,
    mappings,
  }

  return {
    kind: 'built',
    brief: {
      manifest,
      briefHash: sha256(JSON.stringify(manifest)).slice(0, 12),
      evidenceOutput: evidenceRow?.output ?? null,
      impact: impact(db, target),
    },
  }
}

/** The approvable hash for a clause right now, or null when the brief refuses. */
export const currentBriefHash = (db: Database, workspaceRoot: string, target: ClauseTarget): string | null => {
  const outcome = buildBrief(db, workspaceRoot, target)
  return outcome.kind === 'built' ? outcome.brief.briefHash : null
}

export interface BriefHistoryLine {
  when: number
  what: string
  note: string | null
}

const MAPPING_DISPLAY_LINES = 40

/** Shared text renderer — the CLI prints it raw, `urtext ui` wraps it in <pre>
 * (one renderer, no second source of truth). */
export const renderBriefText = (brief: Brief, history: BriefHistoryLine[] = []): string => {
  const { manifest } = brief
  const lines: string[] = []
  const risk = manifest.risk === 'high' ? ' [high]' : ''
  const oracle = manifest.oracleKind
    ? `${manifest.oracleKind}${manifest.oracleRef ? `:${manifest.oracleRef}` : ''}`
    : 'none'
  lines.push(`${manifest.specPath}#${manifest.clauseId} ${manifest.title}${risk}`)
  lines.push(`  head: ${manifest.head?.slice(0, 7) ?? 'n/a'}  oracle: ${oracle}${manifest.stale ? '  STALE — re-verify required' : ''}`)
  if (manifest.refs.length > 0) lines.push(`  refs: ${manifest.refs.join(', ')}`)
  if (manifest.reqs.length > 0) lines.push(`  req: ${manifest.reqs.join(', ')}`)
  if (manifest.body) {
    lines.push('')
    for (const bodyLine of manifest.body.split('\n')) lines.push(`  ${bodyLine}`)
  }

  lines.push('')
  if (manifest.mappings.length === 0) {
    lines.push('  mappings: none recorded for this clause')
  } else {
    lines.push(`  mappings (${manifest.mappings.length}):`)
    for (const mapping of manifest.mappings) {
      const note = mapping.note ? ` — ${mapping.note}` : ''
      lines.push(`    ${mapping.filePath}:${mapping.lineStart}-${mapping.lineEnd} @ ${mapping.commitSha.slice(0, 7)}${note}`)
      if (mapping.content === null) {
        lines.push('      (file missing from the working tree)')
        continue
      }
      const contentLines = mapping.content.split('\n')
      contentLines.slice(0, MAPPING_DISPLAY_LINES).forEach((contentLine, index) => {
        lines.push(`      ${mapping.lineStart + index} | ${contentLine}`)
      })
      if (contentLines.length > MAPPING_DISPLAY_LINES) {
        lines.push(`      … ${contentLines.length - MAPPING_DISPLAY_LINES} more line(s) (hashed in full)`)
      }
    }
  }

  lines.push('')
  if (manifest.evidence === null) {
    lines.push('  evidence: none — run `urtext verify`')
  } else {
    lines.push(
      `  evidence: ${manifest.evidence.verdict} (exit ${manifest.evidence.exitCode ?? 'n/a'})  audit: ${manifest.auditVerdict ?? 'unaudited'}`
    )
    if (brief.evidenceOutput) {
      for (const outputLine of brief.evidenceOutput.split('\n').slice(0, 6)) {
        lines.push(`      ${outputLine}`)
      }
    }
  }

  const affected = brief.impact.affectedClauses
  const tasks = brief.impact.affectedTasks
  lines.push(
    `  impact: ${affected.length} dependent clause(s)${affected.length > 0 ? ` — ${affected.map((c) => `${c.specPath}#${c.clauseId}`).join(', ')}` : ''}; ${tasks.length} task(s)`
  )
  if (history.length > 0) {
    lines.push('  history:')
    for (const entry of history) {
      const when = new Date(entry.when).toISOString().slice(0, 19).replace('T', ' ')
      lines.push(`    ${when} ${entry.what}${entry.note ? ` — ${entry.note}` : ''}`)
    }
  }
  lines.push('')
  lines.push(`  brief-hash: ${brief.briefHash}`)
  return lines.join('\n')
}
