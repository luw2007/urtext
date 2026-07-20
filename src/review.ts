/**
 * Unsafe lane (VISION P5) — the human code-review workflow for `risk:high`
 * clauses. Spec can never fully carry the semantics of money paths,
 * migrations, concurrency, or irreversible operations, so on those clauses
 * the CODE stays the only reviewable truth: a high-risk clause never
 * auto-passes on evidence alone; a human must review the code and record an
 * approve/reject decision.
 *
 * A review binds to the HEAD sha it was made against — if the code moves
 * (new commit), the approval lapses and the clause must be re-reviewed. This
 * is the same "provenance against a real commit" discipline as DWARF (D4).
 * The decision is persisted as a durable record (the Decision ledger seed).
 */

import { spawnSync } from 'node:child_process'

import type { Database } from 'better-sqlite3'

import { currentBriefHash } from './brief.js'

export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_path   TEXT    NOT NULL,
  clause_id   TEXT    NOT NULL,
  commit_sha  TEXT    NOT NULL,
  decision    TEXT    NOT NULL CHECK (decision IN ('approve', 'reject')),
  reviewer    TEXT    NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
`

export const ensureReviewLedger = (db: Database): void => {
  db.exec(REVIEW_SCHEMA)
}

export type ReviewDecision = 'approve' | 'reject'

export interface ReviewInput {
  specPath: string
  clauseId: string
  decision: ReviewDecision
  reviewer: string
  note?: string
  /** Freshness token from `urtext brief` — required to approve (P2 hardening). */
  briefHash?: string
}

export type ReviewOutcome =
  | { kind: 'recorded'; id: number; commitSha: string }
  | {
      kind: 'rejected'
      code:
        | 'unknown_clause'
        | 'not_high_risk'
        | 'dirty_worktree'
        | 'brief_required'
        | 'brief_stale'
        | 'git_failed'
      message: string
    }

/** Current HEAD sha, or null when not a git repo / git unavailable. */
export const currentHead = (workspaceRoot: string): string | null => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout.trim()
}

/** True when the worktree has uncommitted state; null when git fails. */
export const worktreeDirty = (workspaceRoot: string): boolean | null => {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: workspaceRoot, encoding: 'utf8' })
  return result.error || result.status !== 0 ? null : result.stdout.trim().length > 0
}

interface LiveClauseRisk {
  risk: 'low' | 'high'
}

/** Risk of the clause in the latest live revision, or null when absent. */
const liveClauseRisk = (db: Database, specPath: string, clauseId: string): 'low' | 'high' | null => {
  const row = db
    .prepare(
      `SELECT c.risk FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       JOIN revisions r ON r.spec_path = c.spec_path AND r.revision = c.revision
       WHERE c.spec_path = ? AND c.clause_id = ? AND r.status != 'tombstoned'`
    )
    .get(specPath, clauseId) as LiveClauseRisk | undefined
  return row?.risk ?? null
}

/**
 * Record a human code-review decision for a high-risk clause, bound to the
 * current HEAD. Only high-risk clauses enter this lane — a low-risk clause
 * rides evidence + meta-audit and needs no code review.
 *
 * Approving carries two fail-closed preconditions (P2 hardening; rejecting
 * is conservative and needs neither):
 *  - clean worktree — a HEAD-bound approval cannot cover uncommitted edits,
 *    so they must be committed (moving HEAD → prior approvals lapse) first;
 *  - a current brief-hash — the approval must reference the clause text,
 *    mapped code content, and evidence state as they are NOW.
 */
export const recordReview = (
  db: Database,
  input: ReviewInput,
  workspaceRoot: string,
  timestamp: number
): ReviewOutcome => {
  ensureReviewLedger(db)
  const risk = liveClauseRisk(db, input.specPath, input.clauseId)
  if (risk === null) {
    return {
      kind: 'rejected',
      code: 'unknown_clause',
      message: `No live clause ${input.specPath}#${input.clauseId} — run \`urtext index\` first.`,
    }
  }
  if (risk !== 'high') {
    return {
      kind: 'rejected',
      code: 'not_high_risk',
      message: `Clause ${input.specPath}#${input.clauseId} is low-risk; the unsafe lane is for risk:high clauses only.`,
    }
  }
  if (input.decision === 'approve') {
    const dirty = worktreeDirty(workspaceRoot)
    if (dirty === null) {
      return { kind: 'rejected', code: 'git_failed', message: 'git status --porcelain failed' }
    }
    if (dirty) {
      return {
        kind: 'rejected',
        code: 'dirty_worktree',
        message:
          'Worktree has uncommitted changes — a HEAD-bound approval would not cover them. Commit first, then review.',
      }
    }
    if (!input.briefHash) {
      return {
        kind: 'rejected',
        code: 'brief_required',
        message: `High-risk approval requires the current brief — run \`urtext brief ${input.specPath}#${input.clauseId}\` and pass --brief <hash>.`,
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
          'The provided brief-hash does not match the current content — re-run `urtext brief` and re-read before approving.',
      }
    }
  }
  const sha = currentHead(workspaceRoot)
  if (sha === null) {
    return { kind: 'rejected', code: 'git_failed', message: 'git rev-parse HEAD failed' }
  }
  const inserted = db
    .prepare(
      `INSERT INTO reviews (spec_path, clause_id, commit_sha, decision, reviewer, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.specPath, input.clauseId, sha, input.decision, input.reviewer, input.note ?? null, timestamp)
  return { kind: 'recorded', id: Number(inserted.lastInsertRowid), commitSha: sha }
}

/**
 * Latest review decision per clause AT `headSha` (older reviews describe
 * other code states and are ignored). A clause with no review at the current
 * head has no entry.
 */
export const reviewsAtHead = (db: Database, headSha: string): Map<string, ReviewDecision> => {
  ensureReviewLedger(db)
  const rows = db
    .prepare(
      `SELECT r.spec_path, r.clause_id, r.decision
       FROM reviews r
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM reviews WHERE commit_sha = ? GROUP BY spec_path, clause_id
       ) latest ON latest.id = r.id`
    )
    .all(headSha) as { spec_path: string; clause_id: string; decision: ReviewDecision }[]
  const map = new Map<string, ReviewDecision>()
  for (const row of rows) map.set(`${row.spec_path}#${row.clause_id}`, row.decision)
  return map
}

export interface ReviewRecord {
  specPath: string
  clauseId: string
  commitSha: string
  decision: ReviewDecision
  reviewer: string
  note: string | null
  createdAt: number
}

/** The full review ledger, newest first (brief history readback). */
export const listReviews = (db: Database): ReviewRecord[] => {
  ensureReviewLedger(db)
  return db
    .prepare(
      `SELECT spec_path AS specPath, clause_id AS clauseId, commit_sha AS commitSha,
              decision, reviewer, note, created_at AS createdAt
       FROM reviews ORDER BY id DESC`
    )
    .all() as ReviewRecord[]
}
