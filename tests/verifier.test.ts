import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { runOracle } from '../src/oracle-runner.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { ensureEvidenceLedger, verifyWorkspace } from '../src/verifier.js'
import { run } from '../src/cli.js'
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
  decs: [],
  reqs: [],
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

interface ColumnRow {
  name: string
}

interface LegacyEvidenceRow {
  invalidated_at: number
  input_fingerprint: string
  invalidation_source: string | null
}

describe('ensureEvidenceLedger', () => {
  test('appends invalidation_source after input_fingerprint without rewriting legacy rows', () => {
    db.exec(`
      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_path TEXT NOT NULL,
        revision INTEGER NOT NULL,
        clause_id TEXT NOT NULL,
        oracle_kind TEXT NOT NULL,
        oracle_ref TEXT,
        verdict TEXT NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        duration_ms INTEGER,
        invalidated_at INTEGER,
        input_fingerprint TEXT
      )
    `)
    db.prepare(
      `INSERT INTO evidence (spec_path, revision, clause_id, oracle_kind, verdict, output, created_at, invalidated_at, input_fingerprint)
       VALUES ('specs/x/spec.md', 1, 'C001', 'cmd', 'pass', '', 1, 7, 'fingerprint')`
    ).run()

    ensureEvidenceLedger(db)
    ensureEvidenceLedger(db)

    const columns = db.prepare(`SELECT name FROM pragma_table_info('evidence')`).all() as ColumnRow[]
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['input_fingerprint', 'invalidation_source'])
    )
    const legacy = db.prepare(
      'SELECT invalidated_at, input_fingerprint, invalidation_source FROM evidence'
    ).get() as LegacyEvidenceRow
    expect(legacy).toEqual({ invalidated_at: 7, input_fingerprint: 'fingerprint', invalidation_source: null })
  })
})

describe('verifyWorkspace', () => {
  const setupWorkspace = (specContent: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-verify-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    writeFileSync(join(root, 'specs/x/spec.md'), `## FR001 test intent\n${specContent}`)
    scanWorkspace(db, root)
    return root
  }

  test('runs oracles for ready clauses, records evidence, aggregates pass rate', () => {
    const root = setupWorkspace(
      [
        '## C001 Always true <!-- oracle:cmd:true req:FR001 -->',
        '## C002 Always false <!-- oracle:cmd:false req:FR001 -->',
        '## C003 Human check <!-- oracle:manual req:FR001 -->',
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
    const root = setupWorkspace('## C001 Always true <!-- oracle:cmd:true req:FR001 -->')
    verifyWorkspace(db, root)
    verifyWorkspace(db, root)
    const count = db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }
    expect(count.n).toBe(2)
  })
  test('importable CLI returns 1 when a ready test oracle fails and appends evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-cli-verify-'))
    tempDirs.push(root)
    const sourceNodeModules = join(process.cwd(), 'node_modules')
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    symlinkSync(sourceNodeModules, join(root, 'node_modules'), 'dir')
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      '## FR001 test intent\n## C001 failing test <!-- oracle:test:tests/failing.test.ts req:FR001 -->'
    )
    writeFileSync(
      join(root, 'tests/failing.test.ts'),
      "import { expect, test } from 'vitest'\n\ntest('ready test oracle fails', () => {\n  expect(true).toBe(false)\n})\n"
    )

    const previous = process.cwd()
    try {
      process.chdir(root)
      expect(run(['verify'])).toBe(1)
    } finally {
      process.chdir(previous)
    }

    const workspaceDb = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'))
    try {
      const evidence = workspaceDb
        .prepare('SELECT clause_id, verdict, exit_code, output FROM evidence ORDER BY id')
        .all() as { clause_id: string; verdict: string; exit_code: number; output: string }[]
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({ clause_id: 'C001', verdict: 'fail', exit_code: 1 })
      expect(evidence[0]?.output).toContain('ready test oracle fails')
    } finally {
      workspaceDb.close()
    }
  })
})
