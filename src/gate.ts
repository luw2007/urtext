/**
 * Risk-tier adjudication gate (VISION P4). Mechanically decides, per clause,
 * whether it may auto-pass or must go to a human — and never the reverse.
 *
 *   auto-pass  ⟺  risk=low ∧ evidence=pass ∧ audit=agree ∧ not stale
 *   human      ⟺  anything else (high risk, missing/failing/pending evidence,
 *                 audit disagree, unaudited, stale) — with explicit reasons
 *
 * The overall merge verdict is auto-pass only when EVERY clause auto-passes
 * AND there are no unmapped working-tree changes (P3 feeds P4). This is the
 * "what triggers a human" boundary from DECISIONS D3 — the human is never
 * silently skipped, and a disagreement never auto-passes.
 *
 * Pure over the registry; the unmapped count is supplied by the caller
 * (computed from the real git diff via dwarf.detectUnmapped).
 */

import type { Database } from 'better-sqlite3'

import { coverage } from './audit.js'
import { reviewsAtHead } from './review.js'
import { ensureEvidenceLedger } from './verifier.js'

export type Decision = 'auto-pass' | 'human'

export interface ClauseDecision {
  specPath: string
  clauseId: string
  title: string
  risk: 'low' | 'high'
  evidenceVerdict: 'pass' | 'fail' | 'pending' | 'missing'
  auditVerdict: 'agree' | 'disagree' | 'unaudited'
  stale: boolean
  /** Human code-review status for high-risk clauses at the current HEAD. */
  reviewStatus: 'approved' | 'rejected' | 'none' | 'n/a'
  decision: Decision
  /** Why this clause needs a human; empty for auto-pass. */
  reasons: string[]
}

export interface GateReport {
  decisions: ClauseDecision[]
  unmappedCount: number
  overall: Decision
  /** Top-level triggers: per-clause escalations plus unmapped changes. */
  reasons: string[]
}

interface LiveClauseRow {
  spec_path: string
  clause_id: string
  title: string
  risk: 'low' | 'high'
}

/** Every clause of the latest live (non-tombstoned) revision per spec file. */
const liveClauses = (db: Database): LiveClauseRow[] =>
  db
    .prepare(
      `SELECT c.spec_path, c.clause_id, c.title, c.risk
       FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       JOIN revisions r ON r.spec_path = c.spec_path AND r.revision = c.revision
       WHERE r.status != 'tombstoned'
       ORDER BY c.spec_path, c.seq`
    )
    .all() as LiveClauseRow[]

interface EvidenceState {
  verdict: 'pass' | 'fail' | 'pending'
  stale: boolean
}

/** Latest evidence verdict + stale flag per clause (highest evidence id). */
const evidenceByClause = (db: Database): Map<string, EvidenceState> => {
  ensureEvidenceLedger(db)
  const rows = db
    .prepare(
      `SELECT e.spec_path, e.clause_id, e.verdict, e.invalidated_at
       FROM evidence e
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM evidence GROUP BY spec_path, clause_id
       ) latest ON latest.id = e.id`
    )
    .all() as { spec_path: string; clause_id: string; verdict: 'pass' | 'fail' | 'pending'; invalidated_at: number | null }[]
  const map = new Map<string, EvidenceState>()
  for (const row of rows) {
    map.set(`${row.spec_path}#${row.clause_id}`, {
      verdict: row.verdict,
      stale: row.invalidated_at !== null,
    })
  }
  return map
}

/**
 * Adjudicate every live clause and roll up an overall merge verdict.
 * `unmappedCount` comes from the caller's real-diff scan (0 when unchecked).
 * `headSha`, when given, activates the unsafe lane: a high-risk clause with
 * an `approve` review at that commit is cleared for auto-pass; a `reject` or
 * missing review keeps it human.
 */
export const adjudicate = (db: Database, unmappedCount = 0, headSha?: string): GateReport => {
  const evidence = evidenceByClause(db)
  const audits = coverage(db)
  const auditByClause = new Map<string, 'agree' | 'disagree'>()
  for (const row of audits.rows) {
    if (row.auditVerdict) auditByClause.set(`${row.specPath}#${row.clauseId}`, row.auditVerdict)
  }
  const reviews = headSha ? reviewsAtHead(db, headSha) : new Map<string, 'approve' | 'reject'>()

  const decisions: ClauseDecision[] = []
  for (const clause of liveClauses(db)) {
    const key = `${clause.spec_path}#${clause.clause_id}`
    const state = evidence.get(key)
    const evidenceVerdict = state?.verdict ?? 'missing'
    const stale = state?.stale ?? false
    const auditVerdict = auditByClause.get(key) ?? 'unaudited'

    const reasons: string[] = []
    // Unsafe lane (P5): a high-risk clause needs a human code-review approval
    // at the current HEAD; evidence alone never clears it.
    let reviewStatus: ClauseDecision['reviewStatus'] = 'n/a'
    if (clause.risk === 'high') {
      const review = reviews.get(key)
      reviewStatus = review === 'approve' ? 'approved' : review === 'reject' ? 'rejected' : 'none'
      if (reviewStatus === 'rejected') reasons.push('high-risk: human code review REJECTED (P5)')
      else if (reviewStatus === 'none') reasons.push('high-risk: needs human code review — `urtext review` (P5)')
    }
    if (evidenceVerdict === 'missing') reasons.push('no evidence — run `urtext verify`')
    else if (evidenceVerdict === 'fail') reasons.push('evidence failing')
    else if (evidenceVerdict === 'pending') reasons.push('evidence pending (manual oracle unadjudicated)')
    if (stale) reasons.push('stale — upstream changed, re-verify required')
    if (auditVerdict === 'disagree') reasons.push('meta-audit disagreement (D3)')
    else if (auditVerdict === 'unaudited') reasons.push('no meta-audit verdict')

    decisions.push({
      specPath: clause.spec_path,
      clauseId: clause.clause_id,
      title: clause.title,
      risk: clause.risk,
      evidenceVerdict,
      auditVerdict,
      stale,
      reviewStatus,
      decision: reasons.length === 0 ? 'auto-pass' : 'human',
      reasons,
    })
  }

  const reasons: string[] = []
  const humanClauses = decisions.filter((decision) => decision.decision === 'human')
  if (humanClauses.length > 0) {
    reasons.push(`${humanClauses.length} clause(s) require human adjudication`)
  }
  if (unmappedCount > 0) {
    reasons.push(`${unmappedCount} unmapped change(s) (P3: write back to spec or ack)`)
  }
  return {
    decisions,
    unmappedCount,
    overall: reasons.length === 0 ? 'auto-pass' : 'human',
    reasons,
  }
}
