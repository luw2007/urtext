import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

/**
 * I2 §Contract: "full-test must use local tools/built CLI and no naked
 * npx/tsx" — static checks over the shell scripts themselves, not just their
 * runtime behavior, so a future edit can't silently reintroduce a dynamic
 * `npx`/`tsx` invocation.
 */

const fullTest = readFileSync(join(process.cwd(), 'scripts/full-test.sh'), 'utf8')
const oracleTypecheck = readFileSync(join(process.cwd(), 'scripts/oracle-typecheck.sh'), 'utf8')
const wikiOracle = readFileSync(join(process.cwd(), 'scripts/oracle-wiki.sh'), 'utf8')
const repoTypecheck = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.repo.json'), 'utf8')) as {
  compilerOptions: Record<string, unknown>
  include: string[]
}

test('full-test.sh never invokes tsx', () => {
  expect(fullTest).not.toMatch(/\btsx\b/)
})

test('full-test.sh never invokes bare npx tsc/vitest/tsc (only via resolved local binary vars)', () => {
  expect(fullTest).not.toMatch(/\bnpx\s+(tsc|vitest)\b/)
})

test('full-test.sh resolves tsc and vitest from local node_modules/.bin and fails if absent', () => {
  expect(fullTest).toMatch(/node_modules\/\.bin\/tsc/)
  expect(fullTest).toMatch(/node_modules\/\.bin\/vitest/)
  expect(fullTest).toMatch(/no dynamic install fallback/)
})

test('full-test.sh runs the built CLI (dist/cli.js), not a source-transpiling runner', () => {
  expect(fullTest).toMatch(/node dist\/cli\.js verify/)
})

test('oracle-typecheck.sh never invokes bare npx and fails closed without a local tsc', () => {
  expect(oracleTypecheck).not.toMatch(/\bnpx\b/)
  expect(oracleTypecheck).toMatch(/node_modules\/\.bin\/tsc/)
  expect(oracleTypecheck).toMatch(/no dynamic install fallback/)
})

test('C005 repo-wide strict typecheck includes source, tests, scripts and the oracle runs both projects', () => {
  expect(repoTypecheck.compilerOptions).toMatchObject({ noEmit: true, strict: true, exactOptionalPropertyTypes: true })
  expect(repoTypecheck.include).toEqual(['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'])
  expect(oracleTypecheck).toContain('tsconfig.json')
  expect(oracleTypecheck).toContain('tsconfig.repo.json')
})

test('C015 command coverage derives and executes the cli.ts runtime command list', () => {
  expect(wikiOracle).toContain('src/cli.ts')
  expect(wikiOracle).toContain('commands=$(command_names)')
  expect(wikiOracle).not.toContain('for cmd in index check verify')
  const result = spawnSync('sh', ['scripts/oracle-wiki.sh', 'command-coverage'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain("verified: runtime command 'verify'")
  expect(result.stdout).toContain("verified: runtime command 'ui'")
})
