/**
 * Verifier — executes oracles for every clause in the latest `ready` revision
 * of each clause file, records evidence append-only, and reports completion
 * as evidence pass-rate (VISION P2: completion is a read-only aggregate of
 * objective verdicts; nothing here "scores" anything).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from 'better-sqlite3'

import { isOracleKind, type ParsedClause } from './clause-parser.js'
import { runOracle, runTestBatch, type Verdict } from './oracle-runner.js'

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
  duration_ms INTEGER,
  invalidated_at INTEGER,
  input_fingerprint TEXT
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
  if (!columns.some((column) => column.name === 'duration_ms')) {
    db.exec('ALTER TABLE evidence ADD COLUMN duration_ms INTEGER')
  }
  if (!columns.some((column) => column.name === 'input_fingerprint')) {
    db.exec('ALTER TABLE evidence ADD COLUMN input_fingerprint TEXT')
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
  /** Oracle wall-clock time; identifies which oracle slows `verify` down. */
  durationMs: number
  /** `run` = executed this pass; `reused` = incremental served the prior row. */
  source: 'run' | 'reused'
}

export interface VerifyReport {
  verdicts: ClauseVerdict[]
  /** pass / (pass + fail); pending excluded from the denominator. */
  passRate: number | null
  manualShare: number | null
  counts: { pass: number; fail: number; pending: number }
  /** Verdicts served from prior evidence; 0 unless `--incremental`. */
  reusedCount: number
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

const git = (args: string[], cwd: string): string | null => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1_024 * 1_024,
    timeout: 30_000,
  })
  return result.error || result.status !== 0 ? null : (result.stdout ?? '')
}

/**
 * One hash over everything git can see: runtime identity prevents reuse across
 * Node/platform/architecture changes, HEAD pins all clean tracked content, the
 * patch pins every tracked modification, and untracked file bytes pin the rest.
 * `--binary` is load-bearing — without it two different binary blobs both
 * render as "Binary files … differ" and would hash identically.
 *
 * `--exclude-standard` honours .gitignore, which lists `.urtext/` — so verify's
 * own evidence writes do not perturb the fingerprint. `package-lock.json` is
 * tracked, so dependency drift IS covered.
 *
 * null means "never reuse": no git, unborn HEAD, or an unreadable input.
 *
 * simplified: whole-workspace granularity — ANY edit re-runs ALL test oracles.
 * Affordable only because the batched full run is ~50s; revisit if the bound
 * suite ever approaches the full-run budget. Git-ignored runtime inputs remain
 * outside this ceiling, so incremental reuse stays explicit and opt-in.
 */
const workspaceFingerprint = (workspaceRoot: string): string | null => {
  const head = git(['rev-parse', 'HEAD'], workspaceRoot)
  const dirty = git(['diff', 'HEAD', '--binary'], workspaceRoot)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], workspaceRoot)
  if (head === null || dirty === null || untracked === null) return null
  const hash = createHash('sha256')
    .update(process.version)
    .update('\u0000')
    .update(`${process.platform}/${process.arch}`)
    .update('\u0000')
    .update(head)
    .update('\u0000')
    .update(dirty)
  for (const path of untracked.split('\u0000').filter(Boolean)) {
    // Delimit path and content: without separators, path 'a' + bytes 'bc'
    // would hash identically to path 'ab' + bytes 'c'.
    hash.update('\u0000')
    hash.update(path)
    hash.update('\u0000')
    try {
      hash.update(readFileSync(join(workspaceRoot, path)))
    } catch {
      return null
    }
  }
  return hash.digest('hex')
}

interface ReusableEvidence {
  revision: number
  output: string
  durationMs: number
}

/**
 * Latest evidence per clause, narrowed to rows safe to serve without running.
 * The `MAX(id)` join is deliberate: a newer fail/pending row must always beat
 * an older pass, or reuse could resurrect a superseded green. Each guard is a
 * separate readable line rather than a WHERE clause — this is the predicate a
 * reviewer must be able to audit at a glance.
 */
const reusableEvidence = (
  db: Database,
  fingerprint: string
): Map<string, ReusableEvidence> => {
  const rows = db
    .prepare(
      `SELECT e.spec_path, e.clause_id, e.revision, e.verdict, e.output,
              e.duration_ms, e.invalidated_at, e.input_fingerprint
       FROM evidence e
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id FROM evidence GROUP BY spec_path, clause_id
       ) latest ON latest.id = e.id
       WHERE e.oracle_kind = 'test'`
    )
    .all() as {
      spec_path: string
      clause_id: string
      revision: number
      verdict: string
      output: string
      duration_ms: number | null
      invalidated_at: number | null
      input_fingerprint: string | null
    }[]
  const map = new Map<string, ReusableEvidence>()
  for (const row of rows) {
    if (row.verdict !== 'pass') continue
    if (row.invalidated_at !== null) continue
    if (row.input_fingerprint !== fingerprint) continue
    map.set(`${row.spec_path}#${row.clause_id}`, {
      revision: row.revision,
      output: row.output,
      durationMs: row.duration_ms ?? 0,
    })
  }
  return map
}

export const verifyWorkspace = (
  db: Database,
  workspaceRoot: string,
  only?: { specPath: string; clauseId: string },
  options?: { incremental?: boolean }
): VerifyReport => {
  ensureEvidenceLedger(db)
  const insert = db.prepare(
    `INSERT INTO evidence
       (spec_path, revision, clause_id, oracle_kind, oracle_ref, verdict, exit_code,
        output, created_at, duration_ms, input_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const rows = only
    ? readyClauses(db).filter(
        (row) => row.spec_path === only.specPath && row.clause_id === only.clauseId
      )
    : readyClauses(db)

  // Always stamp the fingerprint so a plain full `verify` primes later
  // incremental runs; only the reuse LOOKUP is gated on the flag.
  const preFingerprint = workspaceFingerprint(workspaceRoot)
  const reusable =
    options?.incremental === true && preFingerprint !== null
      ? reusableEvidence(db, preFingerprint)
      : new Map<string, ReusableEvidence>()

  // Every distinct `test` ref that must actually run, in ONE vitest process.
  // Refs whose clause is reusable are excluded, so incremental shrinks the
  // batch rather than filtering its output.
  const refs = [
    ...new Set(
      rows
        .filter((row) => row.oracle_kind === 'test' && row.oracle_ref)
        .filter((row) => {
          const prior = reusable.get(`${row.spec_path}#${row.clause_id}`)
          return prior === undefined || prior.revision !== row.revision
        })
        .map((row) => row.oracle_ref!)
    ),
  ]
  // Escape hatch for the one genuinely new risk (cross-file interference) and
  // the harness that proves batch ≡ solo. Grouping is the only difference.
  const grouped = process.env.URTEXT_VERIFY_BATCH !== '0'
  const batch = grouped
    ? runTestBatch(refs, workspaceRoot)
    : new Map(refs.flatMap((ref) => [...runTestBatch([ref], workspaceRoot)]))

  // An edit landing while oracles ran means the evidence no longer describes
  // the current tree; stamp NULL so such rows are never reusable.
  const stampFingerprint =
    preFingerprint !== null && workspaceFingerprint(workspaceRoot) === preFingerprint
      ? preFingerprint
      : null

  const verdicts: ClauseVerdict[] = []
  const counts = { pass: 0, fail: 0, pending: 0 }
  let manualCount = 0
  let reusedCount = 0

  for (const row of rows) {
    if (row.oracle_kind === 'manual') manualCount++
    const prior = reusable.get(`${row.spec_path}#${row.clause_id}`)
    if (prior !== undefined && prior.revision === row.revision) {
      // Reuse appends NO evidence row. The ledger keeps exactly the row a real
      // oracle produced, so the P2 aggregate still reads only executed
      // verdicts — nothing is fabricated, nothing is overwritten.
      counts.pass++
      reusedCount++
      verdicts.push({
        specPath: row.spec_path,
        revision: row.revision,
        clauseId: row.clause_id,
        title: row.title,
        risk: row.risk,
        oracleKind: row.oracle_kind ?? 'missing',
        verdict: 'pass',
        output: prior.output,
        durationMs: prior.durationMs,
        source: 'reused',
      })
      continue
    }

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
      reqs: [],
      body: row.body,
      line: row.line,
    }
    const batched =
      row.oracle_kind === 'test' && row.oracle_ref ? batch.get(row.oracle_ref) : undefined
    const startedAt = Date.now()
    const result = batched ?? runOracle(clause, workspaceRoot)
    // A batched clause's cost is its files' own test time, not this loop's
    // wall clock — its work happened before the loop, concurrently with peers.
    const durationMs = batched ? batched.durationMs : Date.now() - startedAt

    insert.run(
      row.spec_path,
      row.revision,
      row.clause_id,
      row.oracle_kind ?? 'missing',
      row.oracle_ref,
      result.verdict,
      result.exitCode,
      result.output,
      Date.now(),
      durationMs,
      // A pass attributed out of a red batch may be riding an unattributable
      // leak; it keeps its verdict but must never become reusable.
      batched?.tainted === true ? null : stampFingerprint
    )

    counts[result.verdict]++
    verdicts.push({
      specPath: row.spec_path,
      revision: row.revision,
      clauseId: row.clause_id,
      title: row.title,
      risk: row.risk,
      oracleKind: row.oracle_kind ?? 'missing',
      verdict: result.verdict,
      output: result.output,
      durationMs,
      source: 'run',
    })
  }

  const decided = counts.pass + counts.fail
  const total = verdicts.length
  return {
    verdicts,
    passRate: decided > 0 ? counts.pass / decided : null,
    manualShare: total > 0 ? manualCount / total : null,
    counts,
    reusedCount,
  }
}
