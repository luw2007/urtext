/**
 * Decision ledger (DESIGN §7 memory layer) — durable record of human
 * adjudications for `manual` oracle clauses.
 *
 * A manual clause yields `pending` forever: no runnable oracle can decide it,
 * so a human must. Recording that judgment here is what DESIGN line 44 defers
 * ("pending 不阻塞（人工裁决在后续里程碑接 Decision）") — the gate then treats a
 * manual clause with a `pass` decision at the current HEAD as satisfied.
 *
 * Two guards keep this honest:
 *  - Only `manual` clauses are adjudicable. A test/cmd/metric/diff-scope clause
 *    has an objective oracle; letting a human hand-wave it would break P2
 *    (completion = evidence, AI/humans don't score runnable clauses).
 *  - A decision binds to the HEAD sha it was made at; when code moves the
 *    decision lapses and must be re-made (same discipline as reviews/DWARF).
 */

import { spawnSync } from 'node:child_process'

import type { Database } from 'better-sqlite3'

import { currentBriefHash } from './brief.js'

export const DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_path   TEXT    NOT NULL,
  clause_id   TEXT    NOT NULL,
  commit_sha  TEXT    NOT NULL,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('pass', 'fail')),
  decider     TEXT    NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
`

export const ensureDecisionLedger = (db: Database): void => {
  db.exec(DECISION_SCHEMA)
}

export type DecisionVerdict = 'pass' | 'fail'

export interface DecisionInput {
  specPath: string
  clauseId: string
  verdict: DecisionVerdict
  decider: string
  note?: string
  /** Freshness token from `urtext brief` — required to pass a high-risk manual clause. */
  briefHash?: string
}

export type DecisionOutcome =
  | { kind: 'recorded'; id: number; commitSha: string }
  | {
      kind: 'rejected'
      code:
        | 'unknown_clause'
        | 'not_manual'
        | 'dirty_worktree'
        | 'brief_required'
        | 'brief_stale'
        | 'git_failed'
      message: string
    }

export interface DecisionRecord {
  specPath: string
  clauseId: string
  commitSha: string
  verdict: DecisionVerdict
  decider: string
  note: string | null
  createdAt: number
}

/** Current HEAD sha, or null when not a git repo / git unavailable. */
export const currentHead = (workspaceRoot: string): string | null => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout.trim()
}

/** True when the worktree has uncommitted state; null when git fails. */
const worktreeDirty = (workspaceRoot: string): boolean | null => {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: workspaceRoot, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout.trim().length > 0
}

/** Oracle kind + risk of the clause in the latest live revision, or null when absent. */
const liveClauseMeta = (
  db: Database,
  specPath: string,
  clauseId: string
): { oracleKind: string; risk: 'low' | 'high' } | null => {
  const row = db
    .prepare(
      `SELECT c.oracle_kind AS oracleKind, c.risk FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       JOIN revisions r ON r.spec_path = c.spec_path AND r.revision = c.revision
       WHERE c.spec_path = ? AND c.clause_id = ? AND r.status != 'tombstoned'`
    )
    .get(specPath, clauseId) as { oracleKind: string | null; risk: 'low' | 'high' } | undefined
  return row === undefined ? null : { oracleKind: row.oracleKind ?? '', risk: row.risk }
}

/**
 * Record a human adjudication for a manual-oracle clause, bound to HEAD.
 * Rejects non-manual clauses (they have an objective oracle, P2). Passing a
 * HIGH-RISK manual clause carries the same fail-closed preconditions as a
 * code-review approval: clean worktree + a current brief-hash (P2 hardening;
 * `--fail` and low-risk decisions are conservative and need neither).
 */
export const recordDecision = (
  db: Database,
  input: DecisionInput,
  workspaceRoot: string,
  timestamp: number
): DecisionOutcome => {
  ensureDecisionLedger(db)
  const meta = liveClauseMeta(db, input.specPath, input.clauseId)
  if (meta === null) {
    return {
      kind: 'rejected',
      code: 'unknown_clause',
      message: `No live clause ${input.specPath}#${input.clauseId} — run \`urtext index\` first.`,
    }
  }
  if (meta.oracleKind !== 'manual') {
    return {
      kind: 'rejected',
      code: 'not_manual',
      message: `Clause ${input.specPath}#${input.clauseId} has a ${meta.oracleKind || 'runnable'} oracle; only manual clauses are humanly adjudicated (P2).`,
    }
  }
  if (meta.risk === 'high' && input.verdict === 'pass') {
    const dirty = worktreeDirty(workspaceRoot)
    if (dirty === null) {
      return { kind: 'rejected', code: 'git_failed', message: 'git status --porcelain failed' }
    }
    if (dirty) {
      return {
        kind: 'rejected',
        code: 'dirty_worktree',
        message:
          'Worktree has uncommitted changes — a HEAD-bound decision would not cover them. Commit first, then decide.',
      }
    }
    if (!input.briefHash) {
      return {
        kind: 'rejected',
        code: 'brief_required',
        message: `Passing a high-risk manual clause requires the current brief — run \`urtext brief ${input.specPath}#${input.clauseId}\` and pass --brief <hash>.`,
      }
    }
    const expected = currentBriefHash(db, workspaceRoot, {
      specPath: input.specPath,
      clauseId: input.clauseId,
    })
    if (expected === null || expected !== input.briefHash) {
      return {
        kind: 'rejected',
        code: 'brief_stale',
        message:
          'The provided brief-hash does not match the current content — re-run `urtext brief` and re-read before deciding.',
      }
    }
  }
  const sha = currentHead(workspaceRoot)
  if (sha === null) {
    return { kind: 'rejected', code: 'git_failed', message: 'git rev-parse HEAD failed' }
  }
  const inserted = db
    .prepare(
      `INSERT INTO decisions (spec_path, clause_id, commit_sha, verdict, decider, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.specPath, input.clauseId, sha, input.verdict, input.decider, input.note ?? null, timestamp)
  return { kind: 'recorded', id: Number(inserted.lastInsertRowid), commitSha: sha }
}

/**
 * Latest decision verdict per clause AT `headSha` (older decisions describe
 * other code states and are ignored). A clause with no decision at the
 * current head has no entry.
 */
export const decisionsAtHead = (db: Database, headSha: string): Map<string, DecisionVerdict> => {
  ensureDecisionLedger(db)
  const rows = db
    .prepare(
      `SELECT d.spec_path, d.clause_id, d.verdict
       FROM decisions d
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM decisions WHERE commit_sha = ? GROUP BY spec_path, clause_id
       ) latest ON latest.id = d.id`
    )
    .all(headSha) as { spec_path: string; clause_id: string; verdict: DecisionVerdict }[]
  const map = new Map<string, DecisionVerdict>()
  for (const row of rows) map.set(`${row.spec_path}#${row.clause_id}`, row.verdict)
  return map
}

/** The full Decision ledger, newest first. */
export const listDecisions = (db: Database): DecisionRecord[] => {
  ensureDecisionLedger(db)
  return db
    .prepare(
      `SELECT spec_path AS specPath, clause_id AS clauseId, commit_sha AS commitSha,
              verdict, decider, note, created_at AS createdAt
       FROM decisions ORDER BY id DESC`
    )
    .all() as DecisionRecord[]
}
