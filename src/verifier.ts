/**
 * Verifier — executes oracles for every clause in the latest `ready` revision
 * of each clause file, records evidence append-only, and reports completion
 * as evidence pass-rate (VISION P2: completion is a read-only aggregate of
 * objective verdicts; nothing here "scores" anything).
 */

import type { Database } from 'better-sqlite3'

import { isOracleKind, type ParsedClause } from './clause-parser.js'
import { runOracle, type Verdict } from './oracle-runner.js'

export const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  oracle_kind TEXT    NOT NULL,
  oracle_ref  TEXT,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('pass', 'fail', 'pending')),
  exit_code   INTEGER,
  output      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  invalidated_at INTEGER
);
`

/**
 * Evidence is append-only except `invalidated_at` — the single mutable audit
 * column, set by the linker when an upstream clause's text changes (stale
 * propagation). Includes the additive migration for M1-era ledgers.
 */
export const ensureEvidenceLedger = (db: Database): void => {
  db.exec(EVIDENCE_SCHEMA)
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('evidence')`)
    .all() as { name: string }[]
  if (!columns.some((column) => column.name === 'invalidated_at')) {
    db.exec('ALTER TABLE evidence ADD COLUMN invalidated_at INTEGER')
  }
}

export interface ClauseVerdict {
  specPath: string
  revision: number
  clauseId: string
  title: string
  risk: 'low' | 'high'
  oracleKind: string
  verdict: Verdict
  output: string
}

export interface VerifyReport {
  verdicts: ClauseVerdict[]
  /** pass / (pass + fail); pending excluded from the denominator. */
  passRate: number | null
  manualShare: number | null
  counts: { pass: number; fail: number; pending: number }
}

interface ReadyClauseRow {
  spec_path: string
  revision: number
  clause_id: string
  title: string
  oracle_kind: string | null
  oracle_ref: string | null
  risk: 'low' | 'high'
  body: string | null
  line: number
}

/** Latest `ready` revision per clause file, with its clause rows. */
const readyClauses = (db: Database): ReadyClauseRow[] =>
  db
    .prepare(
      `SELECT c.spec_path, c.revision, c.clause_id, c.title, c.oracle_kind, c.oracle_ref,
              c.risk, c.body, c.line
       FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions
         WHERE file_kind = 'clauses' AND status = 'ready'
           AND revision = (SELECT MAX(revision) FROM revisions r2 WHERE r2.spec_path = revisions.spec_path)
         GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       ORDER BY c.spec_path, c.seq`
    )
    .all() as ReadyClauseRow[]

export const verifyWorkspace = (db: Database, workspaceRoot: string): VerifyReport => {
  ensureEvidenceLedger(db)
  const insert = db.prepare(
    `INSERT INTO evidence
       (spec_path, revision, clause_id, oracle_kind, oracle_ref, verdict, exit_code, output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const verdicts: ClauseVerdict[] = []
  const counts = { pass: 0, fail: 0, pending: 0 }
  let manualCount = 0

  for (const row of readyClauses(db)) {
    // Rehydrate the minimal ParsedClause surface the runner needs. A `ready`
    // revision guarantees a valid oracle kind (missing/invalid keeps a file
    // at `building`), so a failed guard here means registry corruption.
    const oracleKind =
      row.oracle_kind !== null && isOracleKind(row.oracle_kind) ? row.oracle_kind : null
    const clause: ParsedClause = {
      clauseId: row.clause_id,
      seq: 0,
      title: row.title,
      level: 2,
      oracle: oracleKind ? { kind: oracleKind, ref: row.oracle_ref } : null,
      risk: row.risk,
      refs: [],
      body: row.body,
      line: row.line,
    }
    const result = runOracle(clause, workspaceRoot)

    insert.run(
      row.spec_path,
      row.revision,
      row.clause_id,
      row.oracle_kind ?? 'missing',
      row.oracle_ref,
      result.verdict,
      result.exitCode,
      result.output,
      Date.now()
    )

    counts[result.verdict]++
    if (row.oracle_kind === 'manual') manualCount++
    verdicts.push({
      specPath: row.spec_path,
      revision: row.revision,
      clauseId: row.clause_id,
      title: row.title,
      risk: row.risk,
      oracleKind: row.oracle_kind ?? 'missing',
      verdict: result.verdict,
      output: result.output,
    })
  }

  const decided = counts.pass + counts.fail
  const total = verdicts.length
  return {
    verdicts,
    passRate: decided > 0 ? counts.pass / decided : null,
    manualShare: total > 0 ? manualCount / total : null,
    counts,
  }
}
