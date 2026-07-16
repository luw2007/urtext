import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { indexClauseFile, indexTaskFile, openRegistry, tombstoneFile } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'

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

const VALID_CLAUSES = ['## C001 不可叠加 <!-- oracle:manual -->', 'body'].join('\n')

describe('registry revision chain', () => {
  test('same content is a no-op; new content appends an immutable revision', () => {
    const first = indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 1 })
    expect(first).toMatchObject({ kind: 'indexed', revision: 1, status: 'ready' })

    const unchanged = indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 2 })
    expect(unchanged).toEqual({ kind: 'unchanged', revision: 1 })

    const second = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: `${VALID_CLAUSES}\nmore`,
      timestamp: 3,
    })
    expect(second).toMatchObject({ kind: 'indexed', revision: 2, status: 'ready' })

    // Revision 1 rows are untouched (immutable chain).
    const rows = db
      .prepare('SELECT revision, status FROM revisions WHERE spec_path = ? ORDER BY revision')
      .all('specs/x/spec.md')
    expect(rows).toEqual([
      { revision: 1, status: 'ready' },
      { revision: 2, status: 'ready' },
    ])
  })

  test('a clause without an oracle keeps the revision at building (never activatable)', () => {
    const outcome = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## C001 无门禁子句',
      timestamp: 1,
    })
    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'missing_oracle' }),
    ])
  })

  test('a task citing an undeclared clause is unknown_clause (fail-closed)', () => {
    const outcome = indexTaskFile(db, {
      specPath: 'specs/x/tasks.md',
      content: '- [ ] T001 Task <!-- clauses:C999 -->',
      timestamp: 1,
      unitClauseIds: new Set(['C001']),
    })
    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'unknown_clause', fileId: 'T001' }),
    ])
  })

  test('deletion tombstones a NEW revision without touching history', () => {
    indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 1 })
    const tombstoned = tombstoneFile(db, {
      specPath: 'specs/x/spec.md',
      fileKind: 'clauses',
      timestamp: 2,
    })
    expect(tombstoned).toMatchObject({ kind: 'tombstoned', revision: 2 })

    // Idempotent; a never-indexed path is a no-op.
    expect(
      tombstoneFile(db, { specPath: 'specs/x/spec.md', fileKind: 'clauses', timestamp: 3 })
    ).toEqual({ kind: 'unchanged', revision: 2 })
    expect(tombstoneFile(db, { specPath: 'specs/y/spec.md', fileKind: 'clauses', timestamp: 3 })).toBeNull()

    const clauseRows = db
      .prepare('SELECT clause_id FROM clauses WHERE spec_path = ? AND revision = 1')
      .all('specs/x/spec.md')
    expect(clauseRows).toHaveLength(1)
  })
})

describe('scanWorkspace', () => {
  test('indexes clause files before the checklist so unit refs resolve', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(
      join(root, 'specs/coupon/spec.md'),
      ['## C001 不可叠加 <!-- oracle:test:tests/stack.test.ts -->', 'Given/When/Then'].join('\n')
    )
    writeFileSync(
      join(root, 'specs/coupon/tasks.md'),
      '- [ ] T001 实现校验 <!-- role:coder gate:true clauses:C001 -->'
    )

    const report = scanWorkspace(db, root)
    expect(report.units).toEqual([
      {
        feature: 'coupon',
        clauseFiles: ['specs/coupon/spec.md'],
        taskFile: 'specs/coupon/tasks.md',
      },
    ])
    expect(report.outcomes.map(({ specPath, outcome }) => [specPath, outcome.kind])).toEqual([
      ['specs/coupon/spec.md', 'indexed'],
      ['specs/coupon/tasks.md', 'indexed'],
    ])
    for (const { outcome } of report.outcomes) {
      expect(outcome).toMatchObject({ status: 'ready' })
    }
  })

  test('a checklist citing a clause missing from the unit stays building', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(
      join(root, 'specs/coupon/tasks.md'),
      '- [ ] T001 实现校验 <!-- clauses:C001 -->'
    )

    const report = scanWorkspace(db, root)
    const tasksOutcome = report.outcomes.find(({ specPath }) => specPath.endsWith('tasks.md'))
    expect(tasksOutcome?.outcome).toMatchObject({ kind: 'indexed', status: 'building' })
  })

  test('a workspace without specs/ yields no units', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    expect(scanWorkspace(db, root)).toEqual({
      units: [],
      outcomes: [],
      linkErrors: [],
      stale: { staleClauses: [], invalidatedEvidence: 0 },
    })
  })
})
