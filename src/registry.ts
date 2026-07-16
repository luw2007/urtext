/**
 * Clause registry — reconciles scanned spec files into `.urtext/registry.sqlite`
 * using immutable revision-chain semantics:
 *
 * - One revision chain per file: `(spec_path, revision)`, append-only.
 * - Same content as latest live revision → no-op (`unchanged`).
 * - New content → append revision `latest+1`, `ready` when the parse is clean,
 *   `building` when it has errors — an invalid definition is visible but never
 *   activatable (fail-closed).
 * - Deleted file → append a `tombstoned` revision (content_hash NULL); prior
 *   revisions are never mutated.
 *
 * Two file kinds share the chain: clause files (any `specs/<feature>/*.md`
 * except tasks.md) and checklists (`specs/<feature>/tasks.md`).
 */

import { createHash } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { parseClauseFile, type ClauseParseError } from './clause-parser.js'
import { parseTaskFile, type TaskParseError } from './task-parser.js'

export type FileKind = 'clauses' | 'tasks'

export type IndexOutcome =
  | { kind: 'unchanged'; revision: number }
  | {
      kind: 'indexed'
      revision: number
      status: 'ready' | 'building'
      errors: (ClauseParseError | TaskParseError | CrossRefError)[]
      /**
       * Clause ids whose normative text (title+body) differs from the prior
       * live revision — added and removed ids included. Always [] for task
       * files. The linker propagates stale along the refs graph from these.
       */
      changedClauses: string[]
    }
  | { kind: 'tombstoned'; revision: number }

export interface CrossRefError {
  code: 'unknown_clause'
  fileId: string
  line: number
  message: string
}

const hashContent = (content: string): string =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

export const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS revisions (
  spec_path     TEXT    NOT NULL,
  revision      INTEGER NOT NULL,
  file_kind     TEXT    NOT NULL CHECK (file_kind IN ('clauses', 'tasks')),
  content_hash  TEXT,
  status        TEXT    NOT NULL CHECK (status IN ('ready', 'building', 'tombstoned')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision),
  CHECK ((status = 'tombstoned') = (content_hash IS NULL)),
  CHECK (content_hash IS NULL OR content_hash GLOB 'sha256:*')
);

CREATE TABLE IF NOT EXISTS clauses (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL DEFAULT '',
  oracle_kind TEXT,
  oracle_ref  TEXT,
  risk        TEXT    NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'high')),
  refs        TEXT    NOT NULL DEFAULT '[]',
  body        TEXT,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id),
  FOREIGN KEY (spec_path, revision) REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  file_id     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  checked     INTEGER NOT NULL DEFAULT 0,
  role        TEXT,
  prompt      TEXT,
  depends_on  TEXT    NOT NULL DEFAULT '[]',
  human_gate  INTEGER NOT NULL DEFAULT 0,
  clauses     TEXT    NOT NULL DEFAULT '[]',
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, file_id),
  FOREIGN KEY (spec_path, revision) REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clause_refs (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  to_spec     TEXT    NOT NULL,
  to_clause   TEXT    NOT NULL,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id, to_spec, to_clause),
  FOREIGN KEY (spec_path, revision) REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);
`

export const openRegistry = (db: Database): void => {
  db.exec(REGISTRY_SCHEMA)
  // Additive migration for M1-era registries (predating text_hash).
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('clauses')`)
    .all() as { name: string }[]
  if (!columns.some((column) => column.name === 'text_hash')) {
    db.exec(`ALTER TABLE clauses ADD COLUMN text_hash TEXT NOT NULL DEFAULT ''`)
  }
}

const latestRevision = (
  db: Database,
  specPath: string
): { revision: number; content_hash: string | null; status: string } | undefined =>
  db
    .prepare(
      `SELECT revision, content_hash, status FROM revisions
       WHERE spec_path = ? ORDER BY revision DESC LIMIT 1`
    )
    .get(specPath) as
    | { revision: number; content_hash: string | null; status: string }
    | undefined

const clauseTextHash = (title: string, body: string | null): string =>
  `sha256:${createHash('sha256').update(`${title}\n${body ?? ''}`, 'utf8').digest('hex')}`

/**
 * Reconcile one clause-file snapshot into its revision chain. Persists per-
 * clause `text_hash` (title+body — anchor edits alone are not text changes)
 * and the outgoing `clause_refs` edges, and reports which clause ids changed
 * text versus the prior live revision so the linker can propagate stale.
 */
export const indexClauseFile = (
  db: Database,
  input: { specPath: string; content: string; timestamp: number }
): IndexOutcome => {
  const { specPath, content, timestamp } = input
  const contentHash = hashContent(content)
  const latest = latestRevision(db, specPath)
  if (latest && latest.status !== 'tombstoned' && latest.content_hash === contentHash) {
    return { kind: 'unchanged', revision: latest.revision }
  }

  const parsed = parseClauseFile(content)
  const nextRevision = (latest?.revision ?? 0) + 1
  const status: 'ready' | 'building' = parsed.errors.length === 0 ? 'ready' : 'building'

  // text_hash of the prior live revision, keyed by clause id ([] for rev 1
  // or after a tombstone — nothing existed before, so nothing "changed").
  const priorHashes = new Map<string, string>()
  if (latest && latest.status !== 'tombstoned') {
    const rows = db
      .prepare('SELECT clause_id, text_hash FROM clauses WHERE spec_path = ? AND revision = ?')
      .all(specPath, latest.revision) as { clause_id: string; text_hash: string }[]
    for (const row of rows) priorHashes.set(row.clause_id, row.text_hash)
  }

  const changedClauses: string[] = []
  db.transaction(() => {
    db.prepare(
      `INSERT INTO revisions (spec_path, revision, file_kind, content_hash, status, created_at)
       VALUES (?, ?, 'clauses', ?, ?, ?)`
    ).run(specPath, nextRevision, contentHash, status, timestamp)

    const insert = db.prepare(
      `INSERT INTO clauses
         (spec_path, revision, clause_id, seq, title, text_hash, oracle_kind, oracle_ref, risk, refs, body, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertRef = db.prepare(
      `INSERT OR IGNORE INTO clause_refs (spec_path, revision, clause_id, to_spec, to_clause, line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // Duplicate clause ids keep the revision at `building`; insert first-wins
    // so the PK holds and the broken edit is recorded rather than crashing.
    const inserted = new Set<string>()
    for (const clause of parsed.clauses) {
      if (inserted.has(clause.clauseId)) continue
      inserted.add(clause.clauseId)
      const textHash = clauseTextHash(clause.title, clause.body)
      if (priorHashes.get(clause.clauseId) !== textHash) changedClauses.push(clause.clauseId)
      insert.run(
        specPath,
        nextRevision,
        clause.clauseId,
        clause.seq,
        clause.title,
        textHash,
        clause.oracle?.kind ?? null,
        clause.oracle?.ref ?? null,
        clause.risk,
        JSON.stringify(clause.refs),
        clause.body,
        clause.line
      )
      for (const ref of clause.refs) {
        insertRef.run(specPath, nextRevision, clause.clauseId, ref.path, ref.clauseId, clause.line)
      }
    }
    // Removed clauses changed too — their dependents must re-verify.
    for (const clauseId of priorHashes.keys()) {
      if (!inserted.has(clauseId)) changedClauses.push(clauseId)
    }
  })()

  return { kind: 'indexed', revision: nextRevision, status, errors: parsed.errors, changedClauses }
}

/**
 * Reconcile one checklist snapshot. `unitClauseIds` is the set of clause ids
 * declared by `ready`-or-`building` clause files in the same feature unit;
 * task `clauses:` refs outside it are `unknown_clause` errors (fail-closed).
 */
export const indexTaskFile = (
  db: Database,
  input: { specPath: string; content: string; timestamp: number; unitClauseIds: Set<string> }
): IndexOutcome => {
  const { specPath, content, timestamp, unitClauseIds } = input
  const contentHash = hashContent(content)
  const latest = latestRevision(db, specPath)
  if (latest && latest.status !== 'tombstoned' && latest.content_hash === contentHash) {
    return { kind: 'unchanged', revision: latest.revision }
  }

  const parsed = parseTaskFile(content)
  const crossRefErrors: CrossRefError[] = []
  for (const task of parsed.tasks) {
    for (const clauseId of task.clauses) {
      if (!/^C\d+$/.test(clauseId)) continue // already a malformed_clause_ref parse error
      if (!unitClauseIds.has(clauseId)) {
        crossRefErrors.push({
          code: 'unknown_clause',
          fileId: task.fileId,
          line: task.line,
          message: `Task "${task.fileId}" cites clause "${clauseId}" which no clause file in this feature declares.`,
        })
      }
    }
  }

  const errors = [...parsed.errors, ...crossRefErrors]
  const nextRevision = (latest?.revision ?? 0) + 1
  const status: 'ready' | 'building' = errors.length === 0 ? 'ready' : 'building'

  db.transaction(() => {
    db.prepare(
      `INSERT INTO revisions (spec_path, revision, file_kind, content_hash, status, created_at)
       VALUES (?, ?, 'tasks', ?, ?, ?)`
    ).run(specPath, nextRevision, contentHash, status, timestamp)

    const insert = db.prepare(
      `INSERT INTO tasks
         (spec_path, revision, file_id, seq, title, checked, role, prompt, depends_on, human_gate, clauses, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const inserted = new Set<string>()
    for (const task of parsed.tasks) {
      if (inserted.has(task.fileId)) continue
      inserted.add(task.fileId)
      insert.run(
        specPath,
        nextRevision,
        task.fileId,
        task.seq,
        task.title,
        task.checked ? 1 : 0,
        task.role,
        task.prompt,
        JSON.stringify(task.dependsOn),
        task.humanGate ? 1 : 0,
        JSON.stringify(task.clauses),
        task.line
      )
    }
  })()

  return { kind: 'indexed', revision: nextRevision, status, errors, changedClauses: [] }
}

/**
 * A missing file tombstones a NEW revision — it never mutates or deletes a
 * prior revision. Idempotent; a never-indexed path is a no-op (returns null).
 */
export const tombstoneFile = (
  db: Database,
  input: { specPath: string; fileKind: FileKind; timestamp: number }
): IndexOutcome | null => {
  const { specPath, fileKind, timestamp } = input
  const latest = latestRevision(db, specPath)
  if (!latest) return null
  if (latest.status === 'tombstoned') return { kind: 'unchanged', revision: latest.revision }

  const nextRevision = latest.revision + 1
  db.prepare(
    `INSERT INTO revisions (spec_path, revision, file_kind, content_hash, status, created_at)
     VALUES (?, ?, ?, NULL, 'tombstoned', ?)`
  ).run(specPath, nextRevision, fileKind, timestamp)
  return { kind: 'tombstoned', revision: nextRevision }
}
