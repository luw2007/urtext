import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { runOracle } from '../src/oracle-runner.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'
import type { ParsedClause } from '../src/clause-parser.js'

let db: Database
const tempDirs: string[] = []

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const makeClause = (oracle: ParsedClause['oracle'], risk: 'low' | 'high' = 'low'): ParsedClause => ({
  clauseId: 'C001',
  seq: 1,
  title: 'test clause',
  level: 2,
  oracle,
  risk,
  refs: [],
  body: null,
  line: 0,
})

describe('runOracle', () => {
  test('cmd oracle passes on exit 0 and fails on non-zero', () => {
    expect(runOracle(makeClause({ kind: 'cmd', ref: 'true' }), '/tmp').verdict).toBe('pass')
    expect(runOracle(makeClause({ kind: 'cmd', ref: 'false' }), '/tmp').verdict).toBe('fail')
  })

  test('cmd oracle splits %20-encoded arguments (SYNTAX.md: anchor values have no spaces)', () => {
    expect(runOracle(makeClause({ kind: 'cmd', ref: 'test%20-d%20/tmp' }), '/tmp').verdict).toBe('pass')
    expect(runOracle(makeClause({ kind: 'cmd', ref: 'test%20-d%20/nonexistent-dir' }), '/tmp').verdict).toBe('fail')
  })

  test('manual oracle is pending, never pass — a human must adjudicate', () => {
    const result = runOracle(makeClause({ kind: 'manual', ref: null }), '/tmp')
    expect(result.verdict).toBe('pending')
  })

  test('metric oracle fails explicitly in v0 instead of silently skipping', () => {
    const result = runOracle(makeClause({ kind: 'metric', ref: 'p99<200ms' }), '/tmp')
    expect(result.verdict).toBe('fail')
    expect(result.output).toContain('not supported')
  })

  test('a missing ref on test/cmd/diff-scope oracles fails loudly', () => {
    for (const kind of ['test', 'cmd', 'diff-scope'] as const) {
      expect(runOracle(makeClause({ kind, ref: null }), '/tmp').verdict).toBe('fail')
    }
  })
})

describe('verifyWorkspace', () => {
  const setupWorkspace = (specContent: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-verify-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    writeFileSync(join(root, 'specs/x/spec.md'), specContent)
    scanWorkspace(db, root)
    return root
  }

  test('runs oracles for ready clauses, records evidence, aggregates pass rate', () => {
    const root = setupWorkspace(
      [
        '## C001 Always true <!-- oracle:cmd:true -->',
        '## C002 Always false <!-- oracle:cmd:false -->',
        '## C003 Human check <!-- oracle:manual -->',
      ].join('\n')
    )

    const report = verifyWorkspace(db, root)
    expect(report.counts).toEqual({ pass: 1, fail: 1, pending: 1 })
    expect(report.passRate).toBe(0.5)
    expect(report.manualShare).toBeCloseTo(1 / 3)

    // Evidence is recorded append-only with the verdicts.
    const rows = db
      .prepare('SELECT clause_id, verdict FROM evidence ORDER BY clause_id')
      .all() as { clause_id: string; verdict: string }[]
    expect(rows).toEqual([
      { clause_id: 'C001', verdict: 'pass' },
      { clause_id: 'C002', verdict: 'fail' },
      { clause_id: 'C003', verdict: 'pending' },
    ])
  })

  test('building revisions are never verified (fail-closed upstream)', () => {
    const root = setupWorkspace('## C001 No oracle here')
    const report = verifyWorkspace(db, root)
    expect(report.verdicts).toEqual([])
  })

  test('re-verification appends new evidence, never overwrites', () => {
    const root = setupWorkspace('## C001 Always true <!-- oracle:cmd:true -->')
    verifyWorkspace(db, root)
    verifyWorkspace(db, root)
    const count = db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }
    expect(count.n).toBe(2)
  })
})
