/**
 * Meta-verification audit (DECISIONS D3, VISION P2) — cross-model evidence
 * coverage review, kept strictly at the META layer.
 *
 * Urtext is a serverless CLI and never calls an LLM itself. The D3 rule
 * "implementation preset ≠ audit preset" is enforced OUTSIDE this process:
 *
 *   1. `exportRequest` emits a JSON package — per clause, its semantics plus
 *      the OBJECTIVE evidence an oracle already produced (verdict + output).
 *   2. A different-preset agent reads it and returns per-evidence
 *      agree/disagree: does this evidence actually cover the clause's meaning
 *      (oracle too weak, test cheating, diff-scope evasion)? It does NOT
 *      re-run the implementation — read-only, ~1/10 the token cost.
 *   3. `importVerdicts` ingests those judgments, bound to the exact evidence
 *      row they read (so a later re-verify invalidates the audit too).
 *
 * `disagree` never silently passes: the gate escalates it to a human.
 */

import type { Database } from 'better-sqlite3'

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_verdicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER NOT NULL,
  auditor     TEXT    NOT NULL,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('agree', 'disagree')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (evidence_id) REFERENCES evidence (id)
);
`

export const ensureAuditLedger = (db: Database): void => {
  db.exec(AUDIT_SCHEMA)
}

export interface AuditItem {
  evidenceId: number
  specPath: string
  clauseId: string
  title: string
  body: string | null
  risk: 'low' | 'high'
  oracleKind: string
  oracleRef: string | null
  verdict: string
  output: string
}

export interface AuditRequest {
  /** The auditor must run under a DIFFERENT preset than the implementer (D3). */
  protocol: 'urtext-meta-audit/v0'
  instruction: string
  items: AuditItem[]
}

export interface AuditVerdictInput {
  evidenceId: number
  auditor: string
  verdict: 'agree' | 'disagree'
  note?: string
}

export type ImportOutcome =
  | { kind: 'imported'; count: number }
  | { kind: 'rejected'; code: 'unknown_evidence'; message: string }

export interface CoverageRow {
  specPath: string
  clauseId: string
  evidenceId: number
  evidenceVerdict: string
  auditVerdict: 'agree' | 'disagree' | null
  auditor: string | null
}

export interface CoverageReport {
  rows: CoverageRow[]
  /** audited (agree or disagree) / total live clauses; null when empty. */
  coverage: number | null
  counts: { agree: number; disagree: number; unaudited: number }
}

interface EvidenceRow {
  id: number
  spec_path: string
  clause_id: string
  oracle_kind: string
  verdict: string
  output: string
  invalidated_at: number | null
}

/**
 * The latest evidence row per live clause (highest id). Evidence is
 * append-only, so the highest id is the most recent verify. Includes
 * `invalidated_at` so the gate can treat a stale row as needing re-verify.
 */
export const latestEvidence = (db: Database): EvidenceRow[] =>
  db
    .prepare(
      `SELECT e.id, e.spec_path, e.clause_id, e.oracle_kind, e.verdict, e.output, e.invalidated_at
       FROM evidence e
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM evidence GROUP BY spec_path, clause_id
       ) latest ON latest.id = e.id
       ORDER BY e.spec_path, e.clause_id`
    )
    .all() as EvidenceRow[]

interface ClauseMetaRow {
  spec_path: string
  clause_id: string
  title: string
  body: string | null
  risk: 'low' | 'high'
  oracle_ref: string | null
}

/** Clause semantics of the latest live revision, keyed for join with evidence. */
const clauseMeta = (db: Database): Map<string, ClauseMetaRow> => {
  const rows = db
    .prepare(
      `SELECT c.spec_path, c.clause_id, c.title, c.body, c.risk, c.oracle_ref
       FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' AND status = 'ready' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision`
    )
    .all() as ClauseMetaRow[]
  const map = new Map<string, ClauseMetaRow>()
  for (const row of rows) map.set(`${row.spec_path}#${row.clause_id}`, row)
  return map
}

const AUDIT_INSTRUCTION =
  'For each item, judge whether the recorded evidence actually covers the ' +
  'clause’s meaning (oracle strong enough, no test cheating or diff-scope ' +
  'evasion). Reply per evidenceId with verdict "agree" or "disagree" and a ' +
  'note. Do NOT re-run the implementation. Run under a preset different from ' +
  'the implementer (DECISIONS D3).'

/**
 * Build the audit package: every live clause whose latest evidence is a
 * decided verdict (pass/fail — pending has nothing to audit) and not stale.
 */
export const exportRequest = (db: Database): AuditRequest => {
  ensureAuditLedger(db)
  const meta = clauseMeta(db)
  const items: AuditItem[] = []
  for (const row of latestEvidence(db)) {
    if (row.invalidated_at !== null) continue // stale: re-verify before auditing
    if (row.verdict === 'pending') continue // nothing objective to audit yet
    const clause = meta.get(`${row.spec_path}#${row.clause_id}`)
    if (!clause) continue
    items.push({
      evidenceId: row.id,
      specPath: row.spec_path,
      clauseId: row.clause_id,
      title: clause.title,
      body: clause.body,
      risk: clause.risk,
      oracleKind: row.oracle_kind,
      oracleRef: clause.oracle_ref,
      verdict: row.verdict,
      output: row.output,
    })
  }
  return { protocol: 'urtext-meta-audit/v0', instruction: AUDIT_INSTRUCTION, items }
}

/** Ingest external audit verdicts, each bound to the evidence row it read. */
export const importVerdicts = (
  db: Database,
  verdicts: AuditVerdictInput[],
  timestamp: number
): ImportOutcome => {
  ensureAuditLedger(db)
  const exists = db.prepare('SELECT 1 FROM evidence WHERE id = ?')
  for (const verdict of verdicts) {
    if (exists.get(verdict.evidenceId) === undefined) {
      return {
        kind: 'rejected',
        code: 'unknown_evidence',
        message: `Audit verdict references evidence id ${verdict.evidenceId}, which does not exist.`,
      }
    }
  }
  const insert = db.prepare(
    `INSERT INTO audit_verdicts (evidence_id, auditor, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const verdict of verdicts) {
      insert.run(verdict.evidenceId, verdict.auditor, verdict.verdict, verdict.note ?? null, timestamp)
    }
  })()
  return { kind: 'imported', count: verdicts.length }
}

/** Latest audit verdict per evidence id (highest audit id). */
const latestAuditByEvidence = (db: Database): Map<number, { verdict: 'agree' | 'disagree'; auditor: string }> => {
  const rows = db
    .prepare(
      `SELECT a.evidence_id, a.verdict, a.auditor
       FROM audit_verdicts a
       JOIN (
         SELECT evidence_id, MAX(id) AS id FROM audit_verdicts GROUP BY evidence_id
       ) latest ON latest.id = a.id`
    )
    .all() as { evidence_id: number; verdict: 'agree' | 'disagree'; auditor: string }[]
  const map = new Map<number, { verdict: 'agree' | 'disagree'; auditor: string }>()
  for (const row of rows) map.set(row.evidence_id, { verdict: row.verdict, auditor: row.auditor })
  return map
}

/** Per-clause meta-verification coverage over the latest evidence. */
export const coverage = (db: Database): CoverageReport => {
  ensureAuditLedger(db)
  const audits = latestAuditByEvidence(db)
  const rows: CoverageRow[] = []
  const counts = { agree: 0, disagree: 0, unaudited: 0 }
  for (const evidence of latestEvidence(db)) {
    if (evidence.invalidated_at !== null) continue
    if (evidence.verdict === 'pending') continue
    const audit = audits.get(evidence.id)
    if (audit?.verdict === 'agree') counts.agree++
    else if (audit?.verdict === 'disagree') counts.disagree++
    else counts.unaudited++
    rows.push({
      specPath: evidence.spec_path,
      clauseId: evidence.clause_id,
      evidenceId: evidence.id,
      evidenceVerdict: evidence.verdict,
      auditVerdict: audit?.verdict ?? null,
      auditor: audit?.auditor ?? null,
    })
  }
  const total = rows.length
  return {
    rows,
    coverage: total > 0 ? (counts.agree + counts.disagree) / total : null,
    counts,
  }
}
