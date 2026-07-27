# Plan: cut `urtext verify` from 595s to ~50s full / ~1s incremental

**Author:** OpusPlanner · **Repo:** `/Users/luwei.will/ai/urtext` @ `c181008` · **Date:** 2026-07-27

---

## 0. Measured baseline — and a correction to the brief

Everything below is measured on this machine (M4 Max, 16 cores), not estimated.

**From the evidence ledger** (last full run, `created_at` 2026-07-26 23:36–23:45, 60 clauses):

| oracle kind | clauses | total | share |
|---|---|---|---|
| `test` | 31 | **594.0s** | **99.8%** |
| `cmd` | 25 | 0.68s | 0.11% |
| `manual` | 4 | 0s | 0% |
| **total** | **60** | **595.4s** | |

The 31 `test` clauses bind only **15 distinct refs** (16 files — `tests/spec-impact-` is a live substring filter matching two). One file dominates:

```
tests/distill.test.ts  × 8 clauses × 48.9s = 391.0s   ← 65.7% of the ENTIRE run
tests/dwarf.test.ts    × 2        × 28.0s =  56.0s
tests/status.test.ts   × 2        × 19.5s =  39.1s
brief-gate/decision/review/brief × 1 each =  92.9s
tests/spec-impact-     × 1        ×  7.1s =   7.1s
11 sub-second clause runs                 =   8.6s
```

**Fresh measurements taken for this plan:**

| measurement | result |
|---|---|
| `vitest run tests/registry.test.ts` (solo, cold) | **0.807s** real (461ms reported) |
| `vitest run tests/distill.test.ts` (solo) | **48.88s** real, `user 8.9s` → **18% of one core** |
| `vitest run` — all 37 files, 557 tests | **72.27s** real (445.20s aggregate test time) |
| `vitest run <the 15 bound refs>` — 16 files, 161 tests | **48.88s** real (199.29s aggregate) |
| `urtext check` (scan + link + stale) | **0.089s** |
| `git diff HEAD --binary` | **0.028s** |

### Three corrections the brief needs

1. **"vitest cold start (~2–10s) dominates" is false here.** Cold start is ~0.35s (0.807s total for a 0.46s-of-work file). Across 31 runs that is ~11s of the 594s — **1.8%**. Lever D targets a cost that does not exist.
2. **The real cost is literal duplicated work, not startup.** 594s of serial oracle time collapses to **199s of aggregate test time** when deduplicated. Lever A *parallelizes the duplication*; lever B *eliminates it*.
3. **The floor is one test file.** Running all 15 bound refs in one process takes 48.88s; running `tests/distill.test.ts` alone takes 48.88s. Batch overhead over the slowest single file is **≈0.3s**. No daemon, warm runner, or programmatic API can recover more than that.

---

## 1. Chosen levers

### **Lever B — batch dedup (primary).** Accepted, unmodified in spirit, hardened in detail.

One `spawnSync` of `vitest run` covering every distinct bound ref, with `--reporter=json --outputFile=<tmp>`; per-clause verdicts attributed from the JSON.

### **Lever C — incremental (secondary).** Accepted, but the brief's proposed key is **unsound and is replaced.**

### **Lever A — parallel oracle execution.** **Rejected.** See §5.
### **Lever D — warm vitest Node API.** **Rejected.** See §5.

### Projected budget

| | full | incremental (clean tree) |
|---|---|---|
| `check` (scan/link/stale) | 0.09s | 0.09s |
| workspace fingerprint | — | 0.03s |
| test batch | 48.9s | **0s** |
| `cmd` oracles (serial, 25×) | 0.68s | 0.68s |
| insert + report | ~0.1s | ~0.1s |
| **total** | **≈49.8s** (12.0×, target 120s) | **≈0.9s** (target 15s) |

After any edit, incremental degrades to the full path: ~49.8s — **still 2.4× under the full-run target.** There is no slow path left.

### The critical design consequence

`src/cli.ts:181` is `export const run = (argv: string[]): number` and `src/cli.ts:961` is `process.exit(run(...))`. **Lever B needs zero async.** One `spawnSync` replaces N `spawnSync`s. `run()` stays synchronous, evidence insertion order stays byte-identical to today, and the diff touches three files. Levers A and D both force `run()` async and ripple through the whole CLI to buy nothing.

---

## 2. Core code

### 2.1 `src/oracle-runner.ts` — add `runTestBatch`, make it the single source of truth

```ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
```

```ts
/** A batched verdict carries the oracle's own cost: batch wall time is shared. */
export interface BatchedOracleResult extends OracleResult {
  durationMs: number
}

/**
 * The only fields of vitest's JSON report we bind to. A narrow surface is the
 * point: any shape drift makes the parse fail loudly rather than half-succeed.
 */
interface VitestJsonReport {
  testResults: {
    name: string
    status: string
    startTime: number
    endTime: number
    assertionResults: {
      fullName: string
      status: string
      duration: number | null
      failureMessages: string[]
    }[]
  }[]
}

const readReport = (path: string): VitestJsonReport | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VitestJsonReport
    return Array.isArray(parsed.testResults) ? parsed : null
  } catch {
    return null
  }
}
```

```ts
/**
 * Reproduce vitest's own filter semantics: a positional arg selects every test
 * file whose ROOT-RELATIVE path CONTAINS it as a substring. This is not a
 * detail — `specs/urtext/spec.md#C019` binds `tests/spec-impact-`, which today
 * legitimately runs two files. Exact-path matching would silently change that
 * clause's verdict basis.
 */
const attribute = (
  ref: string,
  report: VitestJsonReport,
  workspaceRoot: string
): BatchedOracleResult => {
  const matched = report.testResults.filter((file) =>
    relative(workspaceRoot, file.name).includes(ref)
  )
  // A multi-filter vitest run exits 0 when ANY filter matches, so an unmatched
  // ref would ride a sibling's green. A solo `vitest run <ref>` exits 1 here;
  // attribution must too, or batching converts a broken binding into a pass.
  if (matched.length === 0) {
    return {
      verdict: 'fail',
      exitCode: 1,
      output: `no test file matched ref '${ref}'`,
      durationMs: 0,
    }
  }
  const lines: string[] = []
  for (const file of matched) {
    for (const assertion of file.assertionResults) {
      const marker = assertion.status === 'passed' ? '✓' : assertion.status === 'failed' ? '✗' : '-'
      lines.push(`${marker} ${assertion.fullName} ${Math.round(assertion.duration ?? 0)}ms`)
      for (const message of assertion.failureMessages) lines.push(message)
    }
  }
  const failed = matched.some((file) => file.status === 'failed')
  return {
    verdict: failed ? 'fail' : 'pass',
    exitCode: failed ? 1 : 0,
    output: capOutput(lines.join('\n'), ''),
    durationMs: matched.reduce((total, file) => total + (file.endTime - file.startTime), 0),
  }
}
```

```ts
/**
 * Run every distinct `test` ref in ONE vitest process. 31 clauses on this repo
 * bind 15 refs; the batch does 199s of test work instead of 594s and finishes
 * in the time of its slowest file.
 *
 * Fail-closed everywhere: a missing binary, a crash, a timeout, or an
 * unparseable report fails EVERY ref with the batch diagnostics. An oracle
 * that could not run must be visible, not a softer kind of green.
 */
export const runTestBatch = (
  refs: string[],
  workspaceRoot: string
): Map<string, BatchedOracleResult> => {
  const results = new Map<string, BatchedOracleResult>()
  if (refs.length === 0) return results

  const vitestBin = join(workspaceRoot, 'node_modules', '.bin', 'vitest')
  if (!existsSync(vitestBin)) {
    for (const ref of refs) {
      results.set(ref, {
        verdict: 'fail',
        exitCode: null,
        output: `local vitest binary not found at ${vitestBin} — no dynamic install fallback`,
        durationMs: 0,
      })
    }
    return results
  }

  const reportDir = mkdtempSync(join(tmpdir(), 'urtext-vitest-'))
  const reportPath = join(reportDir, 'report.json')
  try {
    // `--outputFile` keeps the unbounded JSON off stdout so spawnSync's
    // maxBuffer can never truncate it into a parse failure; `--reporter=dot`
    // preserves a human-readable trace for the catastrophic-failure path.
    const run = spawnSync(
      vitestBin,
      ['run', '--reporter=json', `--outputFile=${reportPath}`, '--reporter=dot', ...refs],
      { cwd: workspaceRoot, encoding: 'utf8', timeout: ORACLE_TIMEOUT_MS }
    )
    const report = readReport(reportPath)
    if (report === null) {
      const diagnostics = run.error
        ? String(run.error)
        : capOutput(run.stdout ?? '', run.stderr ?? '')
      for (const ref of refs) {
        results.set(ref, {
          verdict: 'fail',
          exitCode: run.status,
          output: `vitest batch produced no JSON report\n${diagnostics}`,
          durationMs: 0,
        })
      }
      return results
    }
    for (const ref of refs) results.set(ref, attribute(ref, report, workspaceRoot))
    return results
  } finally {
    rmSync(reportDir, { force: true, recursive: true })
  }
}
```

`runOracle`'s `test` branch collapses to a delegation, so batched and solo runs can never disagree:

```ts
    case 'test': {
      if (!oracle.ref) {
        return { verdict: 'fail', exitCode: null, output: 'test oracle requires a file ref' }
      }
      // One implementation of test-oracle semantics: a solo run is a batch of
      // one. `verify` and a direct `runOracle` call cannot drift apart.
      return runTestBatch([oracle.ref], workspaceRoot).get(oracle.ref)!
    }
```

The verbose-reporter comment it replaces is preserved in intent: the reconstructed output lists every named test with its status and duration, scoped to *this clause's* files instead of the shared process blob. Meta-auditors see strictly more.

### 2.2 `src/verifier.ts` — batch pre-pass, fingerprint, reuse

Schema and migration follow the existing additive pattern exactly:

```ts
  duration_ms INTEGER,
  invalidated_at INTEGER,
  input_fingerprint TEXT
```

```ts
  if (!columns.some((column) => column.name === 'input_fingerprint')) {
    db.exec('ALTER TABLE evidence ADD COLUMN input_fingerprint TEXT')
  }
```

Every pre-existing row has `input_fingerprint = NULL`, which never equals a real fingerprint — **the first run after upgrade is always a full run.** Fail-closed by construction, no backfill.

```ts
const git = (args: string[], cwd: string): string | null => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1_024 * 1_024 })
  return result.error || result.status !== 0 ? null : (result.stdout ?? '')
}

/**
 * One hash over everything git can see: HEAD pins all clean tracked content,
 * the patch pins every tracked modification, and untracked file bytes pin the
 * rest. `--binary` is load-bearing — without it two different binary blobs
 * both render as "Binary files … differ" and would hash identically.
 *
 * `--exclude-standard` honours .gitignore, which lists `.urtext/` — so verify's
 * own evidence writes do not perturb the fingerprint. `package-lock.json` is
 * tracked, so dependency drift IS covered.
 *
 * null means "never reuse": no git, unborn HEAD, or an unreadable input.
 *
 * simplified: whole-workspace granularity — ANY edit re-runs ALL test oracles.
 * Affordable only because the batched full run is ~50s; revisit if the bound
 * suite ever approaches the full-run budget.
 */
const workspaceFingerprint = (workspaceRoot: string): string | null => {
  const head = git(['rev-parse', 'HEAD'], workspaceRoot)
  const dirty = git(['diff', 'HEAD', '--binary'], workspaceRoot)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], workspaceRoot)
  if (head === null || dirty === null || untracked === null) return null
  const hash = createHash('sha256').update(head).update(dirty)
  for (const path of untracked.split('\u0000').filter(Boolean)) {
    hash.update(path)
    try {
      hash.update(readFileSync(join(workspaceRoot, path)))
    } catch {
      return null // an input we cannot pin — fail closed, never reuse
    }
  }
  return hash.digest('hex')
}
```

```ts
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
const reusableEvidence = (db: Database, fingerprint: string): Map<string, ReusableEvidence> => {
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
    if (row.verdict !== 'pass') continue // a red clause always re-runs
    if (row.invalidated_at !== null) continue // stale propagation still forces a run
    if (row.input_fingerprint !== fingerprint) continue // any git-visible drift
    map.set(`${row.spec_path}#${row.clause_id}`, {
      revision: row.revision,
      output: row.output,
      durationMs: row.duration_ms ?? 0,
    })
  }
  return map
}
```

`verifyWorkspace` keeps its existing 3-arg shape (four call sites in tests pass `only` positionally) and gains a 4th optional param:

```ts
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

  const fingerprint = options?.incremental === true ? workspaceFingerprint(workspaceRoot) : null
  const reusable =
    fingerprint === null ? new Map<string, ReusableEvidence>() : reusableEvidence(db, fingerprint)

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
    const batched = row.oracle_kind === 'test' && row.oracle_ref ? batch.get(row.oracle_ref) : undefined
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
      fingerprint
    )

    counts[result.verdict]++
    verdicts.push({ /* …unchanged fields…, */ durationMs, source: 'run' })
  }
  // …aggregate unchanged, plus `reusedCount`
}
```

Interface additions (both additive; `tests/package-surface.test.ts` compares `Object.keys(urtext)`, so types are free and `runTestBatch` deliberately stays out of `src/index.ts`):

```ts
export interface ClauseVerdict {
  // …
  /** `run` = executed this pass; `reused` = incremental served the prior row. */
  source: 'run' | 'reused'
}

export interface VerifyReport {
  // …
  /** Verdicts served from prior evidence; 0 unless `--incremental`. */
  reusedCount: number
}
```

### 2.3 `src/cli.ts` — flag, marker, honest timing

```ts
    const verifyStartedAt = Date.now()
    const verifyReport = verifyWorkspace(db, workspaceRoot, only ?? undefined, {
      incremental: argv.includes('--incremental'),
    })
```

```ts
      const reused = verdict.source === 'reused' ? ', reused' : ''
      console.log(
        `  ${marker} ${verdict.clauseId} ${verdict.title}${risk} (${verdict.oracleKind}, ${verdict.verdict}, ${seconds}s${reused})`
      )
```

```ts
    // Wall time is printed separately from per-clause durations: batched
    // oracles ran concurrently, so the per-clause column deliberately does
    // NOT sum to the elapsed time.
    const elapsed = ((Date.now() - verifyStartedAt) / 1000).toFixed(1)
    const reuse = verifyReport.reusedCount > 0 ? `, ${verifyReport.reusedCount} reused` : ''
    console.log(
      `\n${counts.pass} pass, ${counts.fail} fail, ${counts.pending} pending${reuse} — pass rate ${rate}, manual share ${manual} (${elapsed}s)`
    )
```

USAGE gains one line:

```ts
  '  urtext verify [<spec-path>#<clause-id>] [--incremental]',
  '                   Index + check, then run every clause oracle (or just one)',
  '                   and record evidence; exit 1 on any failing clause.',
  '                   --incremental reuses a passing test-oracle verdict only when',
  '                   nothing git-visible changed since it was recorded.',
```

`argv[1]` handling already tolerates leading `--` (`src/cli.ts:877`), so both `urtext verify --incremental` and `urtext verify specs/x#C001 --incremental` parse with no change.

---

## 3. Incremental semantics — exact predicate and why P2/P3 hold

### The brief's proposed key is unsound. Do not ship it.

> *skip clauses whose latest evidence is pass, not invalidated, and whose clause `text_hash` + HEAD unchanged*

`HEAD unchanged` is true for **every uncommitted working tree** — precisely the state in which you most need verification. That key would skip the entire test suite while you are mid-edit. It also fails the brief's own stated hazard ("a code edit without clause change WOULD be missed"). Replaced.

### Ship this predicate

Clause *X* is served from prior evidence **iff all six hold**:

1. `oracle_kind = 'test'` — the only class worth skipping (594s of 595s).
2. Latest row for *X* (by `MAX(id)`) has `verdict = 'pass'`.
3. That row has `invalidated_at IS NULL`.
4. That row's `revision` equals *X*'s current live revision.
5. That row's `input_fingerprint` equals the current workspace fingerprint.
6. `--incremental` was passed.

Anything else executes.

### Why each guard is load-bearing

| guard | hazard closed |
|---|---|
| (1) test-only | `cmd` has opaque side effects and costs 0.68s total — skipping it buys nothing and risks everything. `diff-scope`'s input *is* the working tree; it must always run. `manual` must stay visibly `pending`. |
| (2) pass-only | A red clause always re-executes, so a fix is never invisible and a failure never freezes. |
| (3) `invalidated_at IS NULL` | Stale propagation (`src/linker.ts:331`) still forces a re-run. This is the brief's explicit non-negotiable. |
| (4) revision equality | Any clause-text or oracle-binding change mints a new revision (`src/registry.ts`, per-file reconciliation). Per-file granularity means an edit to a *sibling* clause also invalidates — conservative, therefore safe. Free: `revision` is already an evidence column. |
| (5) fingerprint equality | **Closes the brief's named hazard.** Any git-visible byte change anywhere — src, tests, specs, `package-lock.json` — invalidates reuse for every clause. |
| (6) opt-in | See below. |

### Why P2 is not weakened

> *completion remains a read-only aggregate of objective verdicts; no caching that can serve stale verdicts for changed clauses.*

- **Reuse writes nothing.** No evidence row is appended, mutated, or synthesized. Every row in the ledger was produced by an oracle that actually executed. The aggregate is unchanged in kind and in value — `passRate` over reused rows is arithmetically identical to what `urtext gate` computes from `latestEvidence(db)`, because they read the same rows.
- **This is not a cache.** A cache stores a computed answer under a key you hope is sufficient. This *declines to overwrite a row that is still the truthful latest*. The evidence ledger was already the source of truth for `gate`, `audit`, and `brief`; incremental simply stops appending a duplicate of a row nobody disputes.
- **Stale propagation still wins** (guard 3), and a changed clause is never reusable (guard 4).

### Why P3 is not weakened

`check --diff` → `detectUnmapped` consumes `diffHunks` derived from the git working-tree diff. The fingerprint's input domain is `HEAD` + `git diff HEAD --binary` + untracked contents — a strict **superset**. Therefore:

> There is no workspace state that P3 classifies as a change and incremental classifies as unchanged.

Incremental can only reuse when P3 has literally nothing to attribute. And **reuse deliberately does not consult the DWARF clause↔code map** to narrow re-runs: `recordMapping` records a *provenance claim*, cross-verified against the diff but never proven complete. Using it as a dependency graph would let an incomplete mapping suppress a real regression. Explicitly rejected in §5.

### Why opt-in, not default

`src/oracle-runner.ts:5` states the house rule: *"an unrunnable oracle must be visible, not a softer kind of green."* A default that silently declines to run oracles is that failure mode wearing a performance costume. `urtext verify` is the evidence-producing gate; its unqualified meaning must stay "I executed every oracle." `--incremental` is for tight loops and pre-commit hooks, where the operator has consciously accepted reuse. The batched full run is ~50s, so nobody is forced into it.

**Residual hazard, stated honestly:** a non-hermetic test oracle (clock, network, git-ignored input) that happens to pass can be reused across an interval in which it would now fail. This is bounded by opt-in, by test-kind-only, and by the fact that `package-lock.json` is tracked. A `.env` file or an `npm i` that changes nothing tracked remains outside the fingerprint — the ceiling comment names it.

---

## 4. Where the remaining 49s lives (lever E, named not taken)

After lever B, **98% of verify wall time is `tests/distill.test.ts`** — 48.24s of test execution across 24 tests at `user 8.9s / real 48.9s`, i.e. 18% of one core, blocked on four `execFileSync` subprocess calls. Cutting it would take full verify to ~10s.

That is test-suite surgery, not verifier work. It changes what the oracles assert, risks the evidence contract, and violates surgical-diff discipline in a performance ticket. **Named with its number, deliberately out of scope.** Upgrade trigger: if the full-run budget ever matters again, this is the only remaining lever worth >1s.

---

## 5. Rejected alternatives

**A — parallel oracle execution with bounded concurrency.** Rejected on measurement, not taste.
- Aggregate test-oracle work is 594s. Wall time under concurrency *N* is bounded below by `max(594/N, 48.9)`: N=8 → ≥74s, worse than B's 49s. Reaching 49s requires N=16 on a 16-core box, where each of 16 vitest processes forks its own worker pool — oversubscription with no headroom.
- It burns 3× the work (594s aggregate vs 199s) to reach a worse number. **A parallelizes the duplication; B eliminates it.**
- It forces `run()` (`src/cli.ts:181`) async, rippling through the whole CLI, and makes evidence insertion order depend on completion order — the brief's "deterministic evidence ordering" becomes a constraint to engineer instead of a property you keep for free.
- For the non-test remainder it optimizes **0.68s across 25 clauses**. Ceiling comment + upgrade trigger: revisit if `SELECT SUM(duration_ms) … WHERE oracle_kind='cmd'` exceeds ~10s.

**D — warm vitest programmatic Node API.** Rejected on arithmetic. Measured vitest process overhead is ~0.3s on a 48.9s batch — **0.6%**. It buys ≤0.3s in exchange for binding urtext to vitest's unstable internal API across majors, forcing async through the CLI, and coupling the oracle runner to one test framework at the library level instead of the CLI level. Lever B already reduces vitest invocations from 31 to 1; there is nothing left for a daemon to amortize.

**Naive lever C (`text_hash` + HEAD).** Rejected: unsound. See §3.

**Per-clause import-graph incrementalism.** Rejected: to skip precisely you must know each test file's transitive import closure — new machinery, a second module resolver, and a permanent correctness liability. It would buy at most 49s on a path that already meets its target with 2.4× margin. Coarse-but-sound beats precise-but-guessed.

**`vitest --changed` to select test files.** Rejected: it would skip *executing* a file while urtext records a `pass` for its clause — fabricating evidence. Outright P2 violation.

**DWARF clause↔code map as the dependency graph.** Rejected: `recordMapping` records a provenance claim, not a proven-complete dependency set. Using it to scope re-verification lets an incomplete mapping hide a regression — a strictly worse failure than being slow.

**Exact-path ref matching instead of substring.** Rejected: `specs/urtext/spec.md#C019` (risk:high) binds `tests/spec-impact-`, which today runs two files. Exact matching would silently narrow a high-risk clause's evidence basis. Attribution must replicate vitest's filter semantics, not improve on them.

**Caching by test-file mtime/content hash per clause.** Rejected: a test file's verdict depends on `src/**` too, so a file-local hash is unsound; a whole-`src` hash is what §3 already does, globally, for free.

---

## 6. Risks

| # | risk | severity | mitigation |
|---|---|---|---|
| R1 | **Cross-file interference.** Batched files share vitest's fork pool; a test that only passes in isolation would flip. | high if real | **Empirically retired:** `vitest run` over all 37 files / 557 tests is green (72.27s), and the exact 16-file bound subset is green (161 tests, 48.88s). Vitest defaults to `pool: 'forks'`, `isolate: true`. Escape hatch `URTEXT_VERIFY_BATCH=0` restores per-ref runs. Bonus: batching makes `urtext verify` and `npm test` agree by construction. |
| R2 | **Unmatched ref rides a sibling's green.** Verified: `vitest run tests/gate.test.ts tests/nope.test.ts` exits **0**; solo `vitest run tests/nope.test.ts` exits **1**. | critical | Zero-match → explicit `fail` in `attribute()`. **New observable contract; needs a test (§7).** |
| R3 | **vitest JSON reporter shape drift** on a major bump. | medium | Bound to 6 fields; drift yields `readReport() === null` → every test clause fails closed with diagnostics. Never silently green. `vitest ^3.2.4` pinned. |
| R4 | **Batch timeout ceiling shrinks.** One `URTEXT_ORACLE_TIMEOUT_MS` (300s default) now covers the whole bound suite, not one file. | low | 6× headroom at 48.9s. Timeout → all test clauses fail closed. Documented; one existing knob, no new config. |
| R5 | **`duration_ms` semantics shift** for test clauses: per-file test time, not per-process wall time. Column no longer sums to elapsed. | low | Intentional and more precise — it still answers "which oracle is slow". CLI prints batch wall time separately so the two are never confused. |
| R6 | **Incremental reuses a non-hermetic pass.** | medium | Opt-in; test-kind only; fingerprint covers all tracked content incl. `package-lock.json`. Ceiling comment names git-ignored inputs. |
| R7 | **Fingerprint self-perturbation** — if `.urtext/` were ever un-ignored, verify's own writes would change the fingerprint. | low | Degrades to full run (fail-safe, never unsafe). `.gitignore` currently lists `.urtext/`, `node_modules/`, `dist/`. |
| R8 | **Substring collision** — a future ref `tests/gate` would bind both `gate.test.ts` and a hypothetical `gate-extra.test.ts`. | low | Identical to today's behavior; stated in a comment so nobody "fixes" it into exact matching and silently changes verdicts. |
| R9 | **JSON report size** for large suites. | low | Written to a temp file (`--outputFile`), so `spawnSync` maxBuffer cannot truncate it; temp dir removed in `finally`. |
| R10 | **Migration on an existing ledger.** | low | Additive nullable column, existing `ensureEvidenceLedger` pattern. All prior rows have `NULL` fingerprint → never reusable → first post-upgrade run is full. |

---

## 7. Acceptance plan

### Must stay green, unmodified

| test | what it pins |
|---|---|
| `tests/oracle-runner-local-tool.test.ts` | **The tightest constraint.** `runOracle` on a `test` kind must still fail closed with `node_modules/.bin/vitest` + `no dynamic install fallback` when the binary is absent, and must return `pass`/`exitCode 0` against a real file. This is exactly why `runOracle` delegates to `runTestBatch([ref])` rather than being replaced. |
| `tests/verifier.test.ts` | `runOracle` cmd/manual/metric/missing-ref semantics; `verifyWorkspace` pass-rate + manual-share aggregation; append-only re-verification (2 rows after 2 runs); building revisions never verified. |
| `tests/verify-failclosed.test.ts` | Positional `only` filter (`verifyWorkspace(db, root, {specPath, clauseId})` — **the reason the options bag is a 4th param, not a 3rd**); non-matching target yields empty report and zero rows; every evidence row records a numeric `duration_ms ≥ 0`. |
| `tests/package-surface.test.ts` | Frozen `Object.keys(urtext)` baseline — **`runTestBatch` must not be re-exported from `src/index.ts`.** |
| `tests/gate.test.ts`, `tests/linker.test.ts`, `tests/registry.test.ts` | `MAX(id)` latest-evidence joins, `invalidated_at` stale propagation, and explicit-column `INSERT INTO evidence` statements all survive the new nullable column. |
| `npm test` (37 files, 557 tests) | Baseline **72.27s / 557 pass**. Any regression here is a real regression. |
| `urtext check && urtext verify` | Self-hosting: **56 pass / 0 fail / 4 pending**, unchanged. |

### New observable contracts requiring tests

1. **An unmatched ref in a multi-ref batch fails.** *(R2 — the one place batching can manufacture a false green.)* Two clauses in one workspace: one bound to a real passing test file, one to a nonexistent ref. Assert the second is `fail` with `no test file matched ref`, and that the first is still `pass`. Without this test the regression is invisible: the run exits 0 and the ledger looks healthy.

2. **Substring ref semantics are preserved.** A clause bound to a shared prefix (mirroring the live `tests/spec-impact-` at `specs/urtext/spec.md:180`) attributes across every matched file: if any matched file fails, the clause fails.

3. **Batch ≡ solo.** Run `verifyWorkspace` twice over the same fixture with `URTEXT_VERIFY_BATCH` unset and `='0'`; assert identical `(clauseId, verdict, exitCode)` tuples. Pins the equivalence R1's escape hatch depends on.

4. **Batch failure fails every ref closed.** Point the workspace at a directory with no `node_modules/.bin/vitest`; assert every test clause is `fail` (not `pending`, not skipped) and the ledger records one row per clause.

5. **Incremental reuse appends no row and marks the verdict.** Fixture with a passing test clause. `verify` → 1 row. `verify --incremental` with an untouched tree → **still 1 row**, `report.reusedCount === 1`, `verdicts[0].source === 'reused'`.

6. **`invalidated_at` defeats reuse.** After a first `verify`, stamp `invalidated_at` (as `propagateStale` does) and run `verify --incremental`. Assert a **new** row is appended and `reusedCount === 0`. *This is the P2 guarantee under test.*

7. **A working-tree edit defeats reuse.** After a first `verify --incremental` in a git fixture, touch a tracked file, re-run. Assert a new row is appended. *This is the exact case the brief's `HEAD unchanged` key would have wrongly skipped — the test exists to keep that mistake from being reintroduced.*

8. **A non-`test` oracle never reuses.** A `cmd` clause re-executes and appends a row under `--incremental` even on a clean tree.

9. **A `fail` verdict never reuses.** A failing test clause re-executes under `--incremental`.

### Performance acceptance (measured, not asserted in CI)

Timing assertions are flaky by nature and are deliberately kept out of the suite. Record in the implementation notes:

| gate | baseline | target | measured basis |
|---|---|---|---|
| `urtext verify` full | 595s | **< 120s** (expect ~50s) | 48.88s batch + 0.68s cmd + 0.09s check |
| `urtext verify --incremental`, clean tree | n/a | **< 15s** (expect ~1s) | 0.09s check + 0.028s fingerprint + 0.68s cmd |
| `urtext verify --incremental`, one src edit | n/a | equals full path (~50s) | full batch |
| verdict parity | 56/0/4 | **identical** | per-clause diff of `(clauseId, verdict)` before vs after |

**Ship gate:** the verdict-parity diff must be empty. A 12× speedup that changes one verdict is a bug, not a win.

---

# OWNER AMENDMENTS (final, binding — adopted from adversarial Codex review)

1. workspaceFingerprint material MUST also include runtime identity: prepend
   process.version and process.platform/process.arch to the hash input, so a
   Node upgrade busts reuse. (Codex point, adopted.)
2. Do NOT hardcode a new clause ID. Adding a self-hosted clause for the new
   observable contracts (batch fail-closed + incremental reuse) is IN scope:
   use the next unclaimed C-id at implementation time, bind oracle:test to the
   new test file.
3. Everything else ships exactly as specified above. --incremental stays opt-in.
