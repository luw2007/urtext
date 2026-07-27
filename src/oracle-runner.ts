/**
 * Oracle runner — executes a clause's oracle and returns an evidence verdict.
 * The verifier's contract (VISION P2): completion is evidence passing, never
 * an opinion. `manual` yields `pending` (a human must adjudicate); `metric`
 * is explicitly unsupported in v0 and FAILS rather than silently skipping —
 * an unrunnable oracle must be visible, not a softer kind of green.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { ParsedClause } from './clause-parser.js'

export type Verdict = 'pass' | 'fail' | 'pending'

export interface OracleResult {
  verdict: Verdict
  exitCode: number | null
  /** Trimmed combined output, capped for storage. */
  output: string
}

/** A batched verdict carries the oracle's own cost: batch wall time is shared. */
export interface BatchedOracleResult extends OracleResult {
  durationMs: number
  /**
   * True when the batch process exited non-zero. A pass from a red batch keeps
   * its per-clause attribution but must never be reusable: the exit code may
   * be explained by a sibling's failure OR by an unattributable leak — the two
   * are indistinguishable from the JSON report.
   */
  tainted: boolean
}

/**
 * The only fields of vitest's JSON report we bind to. A narrow surface is the
 * point: any shape drift makes the parse fail loudly rather than half-succeed.
 */
interface VitestJsonReport {
  testResults: {
    name: string
    status: string
    /** Collection/import failures carry their error here, not in assertions. */
    message: string
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

const OUTPUT_CAP = 4_000

/** Per-oracle wall-clock budget; override for slow gates (e.g. Docker suites). */
const envTimeout = Number(process.env.URTEXT_ORACLE_TIMEOUT_MS)
const ORACLE_TIMEOUT_MS = Number.isInteger(envTimeout) && envTimeout > 0 ? envTimeout : 300_000

const capOutput = (stdout: string, stderr: string): string => {
  const combined = `${stdout}\n${stderr}`.trim()
  return combined.length > OUTPUT_CAP ? `${combined.slice(0, OUTPUT_CAP)}\n…[truncated]` : combined
}

const readReport = (path: string): VitestJsonReport | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VitestJsonReport
    if (!Array.isArray(parsed.testResults)) return null
    // Entry-level shape drift must fail closed, not throw out of attribute().
    const wellFormed = parsed.testResults.every(
      (file) => typeof file.name === 'string' && Array.isArray(file.assertionResults)
    )
    return wellFormed ? parsed : null
  } catch {
    return null
  }
}

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
): Omit<BatchedOracleResult, 'tainted'> => {
  // Lowercase both sides like vitest does (cli-api matchers), so a case-
  // mismatched ref never reports "no test file matched" for a file that ran.
  const needle = ref.toLocaleLowerCase()
  const matched = report.testResults.filter((file) =>
    relative(workspaceRoot, file.name).toLocaleLowerCase().includes(needle)
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
    // A collection/import failure has no assertions; its error lives on the
    // file entry. Without this the evidence output would be empty.
    if (file.assertionResults.length === 0 && file.message) lines.push(file.message)
    for (const assertion of file.assertionResults) {
      const marker =
        assertion.status === 'passed' ? '✓' : assertion.status === 'failed' ? '✗' : '-'
      lines.push(`${marker} ${assertion.fullName} ${Math.round(assertion.duration ?? 0)}ms`)
      for (const message of assertion.failureMessages) lines.push(message)
    }
  }
  const failed = matched.some((file) => file.status === 'failed')
  return {
    verdict: failed ? 'fail' : 'pass',
    exitCode: failed ? 1 : 0,
    output: capOutput(lines.join('\n'), ''),
    durationMs: Math.round(matched.reduce((total, file) => total + (file.endTime - file.startTime), 0)),
  }
}

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
        tainted: true,
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
          tainted: true,
        })
      }
      return results
    }
    // vitest can exit non-zero for conditions it never attributes to a file
    // (unhandled rejections, teardown errors). A parsed-but-green report with
    // a red exit code must fail every ref, or batching turns red into green.
    const unexplained =
      run.error !== undefined ||
      (run.status !== 0 && !report.testResults.some((file) => file.status === 'failed'))
    if (unexplained) {
      const diagnostics = run.error ? String(run.error) : capOutput(run.stdout ?? '', run.stderr ?? '')
      for (const ref of refs) {
        results.set(ref, {
          verdict: 'fail',
          exitCode: run.status,
          output: `vitest batch exited ${run.status} without an attributable file failure\n${diagnostics}`,
          durationMs: 0,
          tainted: true,
        })
      }
      return results
    }
    const tainted = run.error !== undefined || run.status !== 0
    for (const ref of refs) results.set(ref, { ...attribute(ref, report, workspaceRoot), tainted })
    return results
  } finally {
    rmSync(reportDir, { force: true, recursive: true })
  }
}

const runCommand = (command: string, args: string[], cwd: string): OracleResult => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: ORACLE_TIMEOUT_MS })
  if (result.error) {
    return { verdict: 'fail', exitCode: null, output: String(result.error) }
  }
  return {
    verdict: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    output: capOutput(result.stdout ?? '', result.stderr ?? ''),
  }
}

/** Glob → RegExp for diff-scope path matching: `*` within a segment, `**` across. */
const globToRegExp = (glob: string): RegExp => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

const runDiffScope = (allowedGlobs: string, workspaceRoot: string): OracleResult => {
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
  if (diff.error || diff.status !== 0) {
    return {
      verdict: 'fail',
      exitCode: diff.status,
      output: `git diff failed: ${capOutput(diff.stdout ?? '', diff.stderr ?? '')}`,
    }
  }
  const patterns = allowedGlobs
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map(globToRegExp)
  const changed = (diff.stdout ?? '').split('\n').filter(Boolean)
  const violations = changed.filter((file) => !patterns.some((pattern) => pattern.test(file)))
  return violations.length === 0
    ? { verdict: 'pass', exitCode: 0, output: `${changed.length} changed file(s), all in scope` }
    : { verdict: 'fail', exitCode: 1, output: `out-of-scope changes:\n${violations.join('\n')}` }
}

export const runOracle = (clause: ParsedClause, workspaceRoot: string): OracleResult => {
  const oracle = clause.oracle
  if (!oracle) {
    // Unreachable for `ready` revisions (missing oracle keeps a file at
    // `building`), but fail loudly if a caller skips that gate.
    return { verdict: 'fail', exitCode: null, output: 'clause has no oracle' }
  }
  switch (oracle.kind) {
    case 'test': {
      if (!oracle.ref) {
        return { verdict: 'fail', exitCode: null, output: 'test oracle requires a file ref' }
      }
      // One implementation of test-oracle semantics: a solo run is a batch of
      // one. `verify` and a direct `runOracle` call cannot drift apart.
      return runTestBatch([oracle.ref], workspaceRoot).get(oracle.ref)!
    }
    case 'cmd': {
      if (!oracle.ref) {
        return { verdict: 'fail', exitCode: null, output: 'cmd oracle requires a command ref' }
      }
      // Anchor values are whitespace-tokenized, so a cmd ref encodes argument
      // separators as %20 (SYNTAX.md): `scripts/check.sh%20arg` → ['scripts/check.sh', 'arg'].
      const [command, ...args] = oracle.ref.split('%20')
      return runCommand(command!, args, workspaceRoot)
    }
    case 'diff-scope':
      return oracle.ref
        ? runDiffScope(oracle.ref, workspaceRoot)
        : { verdict: 'fail', exitCode: null, output: 'diff-scope oracle requires glob ref' }
    case 'manual':
      return { verdict: 'pending', exitCode: null, output: oracle.ref ?? 'awaiting human check' }
    case 'metric':
      return {
        verdict: 'fail',
        exitCode: null,
        output: 'metric oracles are not supported in v0 — bind test/cmd or mark manual',
      }
  }
}
