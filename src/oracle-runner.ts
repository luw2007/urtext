/**
 * Oracle runner — executes a clause's oracle and returns an evidence verdict.
 * The verifier's contract (VISION P2): completion is evidence passing, never
 * an opinion. `manual` yields `pending` (a human must adjudicate); `metric`
 * is explicitly unsupported in v0 and FAILS rather than silently skipping —
 * an unrunnable oracle must be visible, not a softer kind of green.
 */

import { spawnSync } from 'node:child_process'

import type { ParsedClause } from './clause-parser.js'

export type Verdict = 'pass' | 'fail' | 'pending'

export interface OracleResult {
  verdict: Verdict
  exitCode: number | null
  /** Trimmed combined output, capped for storage. */
  output: string
}

const OUTPUT_CAP = 4_000

/** Per-oracle wall-clock budget; override for slow gates (e.g. Docker suites). */
const envTimeout = Number(process.env.URTEXT_ORACLE_TIMEOUT_MS)
const ORACLE_TIMEOUT_MS = Number.isInteger(envTimeout) && envTimeout > 0 ? envTimeout : 300_000

const capOutput = (stdout: string, stderr: string): string => {
  const combined = `${stdout}\n${stderr}`.trim()
  return combined.length > OUTPUT_CAP ? `${combined.slice(0, OUTPUT_CAP)}\n…[truncated]` : combined
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
    case 'test':
      return oracle.ref
        ? runCommand('npx', ['vitest', 'run', oracle.ref], workspaceRoot)
        : { verdict: 'fail', exitCode: null, output: 'test oracle requires a file ref' }
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
