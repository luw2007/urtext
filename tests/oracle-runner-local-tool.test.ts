import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ParsedClause } from '../src/clause-parser.js'
import { runOracle } from '../src/oracle-runner.js'

/**
 * I2 §Contract: "runOracle test uses local Vitest" — no `npx` fallback, no
 * dynamic install. A `test`-kind oracle must resolve `node_modules/.bin/vitest`
 * relative to the workspace root it is given, and fail closed (never spawn a
 * network-resolving `npx`) when that binary is absent.
 */

const testClause = (ref: string): ParsedClause => ({
  clauseId: 'C001',
  seq: 1,
  title: 'x',
  level: 2,
  oracle: { kind: 'test', ref },
  risk: 'low',
  refs: [],
  reqs: [],
  body: null,
  line: 0,
})

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'urtext-oracle-runner-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

test('missing local vitest binary fails closed with no dynamic install', () => {
  // Deliberately empty workspace: no node_modules/.bin/vitest present.
  const result = runOracle(testClause('tests/does-not-matter.test.ts'), workspace)
  expect(result.verdict).toBe('fail')
  expect(result.exitCode).toBeNull()
  expect(result.output).toContain('node_modules/.bin/vitest')
  expect(result.output).toContain('no dynamic install fallback')
})

test('present local vitest binary is invoked directly, never via npx', () => {
  const result = runOracle(testClause('tests/package-surface.test.ts'), process.cwd())
  // Real repo-local vitest run against a real passing test file.
  expect(result.verdict).toBe('pass')
  expect(result.exitCode).toBe(0)
})
