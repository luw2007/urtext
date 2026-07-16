import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { impact, linkWorkspace, propagateStale } from '../src/linker.js'
import { indexClauseFile, indexTaskFile, openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { ensureEvidenceLedger } from '../src/verifier.js'

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

const index = (specPath: string, content: string, timestamp = 1) =>
  indexClauseFile(db, { specPath, content, timestamp })

// billing/C001 ← coupon/C001 ← checkout/C001 (A refs B = A depends on B).
const seedChain = () => {
  index('specs/billing/spec.md', '## C001 结算不变量 <!-- oracle:manual -->\nbase')
  index(
    'specs/coupon/spec.md',
    '## C001 不可叠加 <!-- oracle:manual refs:specs/billing/spec.md#C001 -->\nmid'
  )
  index(
    'specs/checkout/spec.md',
    '## C001 下单校验 <!-- oracle:manual refs:specs/coupon/spec.md#C001 -->\ntop'
  )
}

describe('linkWorkspace', () => {
  test('resolved cross-file refs produce no errors', () => {
    seedChain()
    expect(linkWorkspace(db)).toEqual([])
  })

  test('a ref to a missing clause or file is unknown_ref (fail-closed)', () => {
    index(
      'specs/coupon/spec.md',
      [
        '## C001 引用缺失子句 <!-- oracle:manual refs:specs/billing/spec.md#C999 -->',
        '## C002 引用缺失文件 <!-- oracle:manual refs:specs/ghost/spec.md#C001 -->',
      ].join('\n')
    )
    index('specs/billing/spec.md', '## C001 存在 <!-- oracle:manual -->')

    const errors = linkWorkspace(db)
    expect(errors).toHaveLength(2)
    expect(errors.map((e) => [e.code, e.clauseId])).toEqual([
      ['unknown_ref', 'C001'],
      ['unknown_ref', 'C002'],
    ])
  })

  test('a dangling ref appears when the TARGET is re-indexed without the clause', () => {
    seedChain()
    expect(linkWorkspace(db)).toEqual([])
    // billing drops C001; coupon file is untouched — per-revision status
    // could never catch this, the workspace-level link pass must.
    index('specs/billing/spec.md', '## C002 改名了 <!-- oracle:manual -->', 2)
    const errors = linkWorkspace(db)
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'unknown_ref',
        specPath: 'specs/coupon/spec.md',
        clauseId: 'C001',
      }),
    ])
  })

  test('a tombstoned target file makes its inbound refs unknown', () => {
    seedChain()
    db.prepare(
      `INSERT INTO revisions (spec_path, revision, file_kind, content_hash, status, created_at)
       VALUES ('specs/billing/spec.md', 2, 'clauses', NULL, 'tombstoned', 2)`
    ).run()
    expect(linkWorkspace(db)).toEqual([
      expect.objectContaining({ code: 'unknown_ref', specPath: 'specs/coupon/spec.md' }),
    ])
  })
})

describe('propagateStale', () => {
  const insertEvidence = (specPath: string, clauseId: string) => {
    ensureEvidenceLedger(db)
    db.prepare(
      `INSERT INTO evidence (spec_path, revision, clause_id, oracle_kind, verdict, output, created_at)
       VALUES (?, 1, ?, 'manual', 'pass', '', 1)`
    ).run(specPath, clauseId)
  }

  test('a text change invalidates evidence along the reverse closure', () => {
    seedChain()
    insertEvidence('specs/billing/spec.md', 'C001')
    insertEvidence('specs/coupon/spec.md', 'C001')
    insertEvidence('specs/checkout/spec.md', 'C001')

    const report = propagateStale(db, [{ specPath: 'specs/billing/spec.md', clauseId: 'C001' }], 99)
    expect(report.staleClauses).toEqual([
      { specPath: 'specs/coupon/spec.md', clauseId: 'C001' },
      { specPath: 'specs/checkout/spec.md', clauseId: 'C001' },
    ])
    expect(report.invalidatedEvidence).toBe(2)

    const rows = db
      .prepare('SELECT spec_path, invalidated_at FROM evidence ORDER BY spec_path')
      .all() as { spec_path: string; invalidated_at: number | null }[]
    expect(rows).toEqual([
      { spec_path: 'specs/billing/spec.md', invalidated_at: null },
      { spec_path: 'specs/checkout/spec.md', invalidated_at: 99 },
      { spec_path: 'specs/coupon/spec.md', invalidated_at: 99 },
    ])
  })

  test('no changed clauses is a no-op', () => {
    seedChain()
    expect(propagateStale(db, [], 99)).toEqual({ staleClauses: [], invalidatedEvidence: 0 })
  })

  test('a ref cycle terminates and marks both sides', () => {
    index(
      'specs/a/spec.md',
      '## C001 甲 <!-- oracle:manual refs:specs/b/spec.md#C001 -->'
    )
    index(
      'specs/b/spec.md',
      '## C001 乙 <!-- oracle:manual refs:specs/a/spec.md#C001 -->'
    )
    const report = propagateStale(db, [{ specPath: 'specs/a/spec.md', clauseId: 'C001' }], 99)
    expect(report.staleClauses).toEqual([{ specPath: 'specs/b/spec.md', clauseId: 'C001' }])
  })
})

describe('scanWorkspace link pass', () => {
  test('editing a clause body invalidates downstream evidence across scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-link-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/billing'), { recursive: true })
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(join(root, 'specs/billing/spec.md'), '## C001 基座 <!-- oracle:manual -->\nv1')
    writeFileSync(
      join(root, 'specs/coupon/spec.md'),
      '## C001 依赖方 <!-- oracle:manual refs:specs/billing/spec.md#C001 -->'
    )

    const first = scanWorkspace(db, root)
    expect(first.linkErrors).toEqual([])
    // First index: every clause is new, but nothing referenced them before —
    // dependents exist, so coupon goes stale off billing's first appearance.
    // Simulate recorded evidence, then change billing's text.
    ensureEvidenceLedger(db)
    db.prepare(
      `INSERT INTO evidence (spec_path, revision, clause_id, oracle_kind, verdict, output, created_at)
       VALUES ('specs/coupon/spec.md', 1, 'C001', 'manual', 'pass', '', 1)`
    ).run()

    writeFileSync(join(root, 'specs/billing/spec.md'), '## C001 基座 <!-- oracle:manual -->\nv2')
    const second = scanWorkspace(db, root)
    expect(second.stale.staleClauses).toEqual([
      { specPath: 'specs/coupon/spec.md', clauseId: 'C001' },
    ])
    expect(second.stale.invalidatedEvidence).toBe(1)
  })

  test('unknown_ref surfaces in the scan report', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-link-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(
      join(root, 'specs/coupon/spec.md'),
      '## C001 悬空引用 <!-- oracle:manual refs:specs/ghost/spec.md#C001 -->'
    )
    const report = scanWorkspace(db, root)
    expect(report.linkErrors).toEqual([
      expect.objectContaining({ code: 'unknown_ref', specPath: 'specs/coupon/spec.md' }),
    ])
  })
})

describe('impact', () => {
  test('reports the reverse closure and citing tasks', () => {
    seedChain()
    indexTaskFile(db, {
      specPath: 'specs/coupon/tasks.md',
      content: '- [ ] T001 实现叠加校验 <!-- clauses:C001 -->',
      timestamp: 1,
      unitClauseIds: new Set(['C001']),
    })
    indexTaskFile(db, {
      specPath: 'specs/checkout/tasks.md',
      content: '- [ ] T001 下单流程 <!-- clauses:C001 -->',
      timestamp: 1,
      unitClauseIds: new Set(['C001']),
    })

    const report = impact(db, { specPath: 'specs/billing/spec.md', clauseId: 'C001' })
    expect(report.affectedClauses).toEqual([
      { specPath: 'specs/coupon/spec.md', clauseId: 'C001' },
      { specPath: 'specs/checkout/spec.md', clauseId: 'C001' },
    ])
    expect(report.affectedTasks).toEqual([
      expect.objectContaining({ specPath: 'specs/coupon/tasks.md', fileId: 'T001' }),
      expect.objectContaining({ specPath: 'specs/checkout/tasks.md', fileId: 'T001' }),
    ])
  })

  test('an unreferenced clause has empty impact', () => {
    seedChain()
    const report = impact(db, { specPath: 'specs/checkout/spec.md', clauseId: 'C001' })
    expect(report.affectedClauses).toEqual([])
    expect(report.affectedTasks).toEqual([])
  })
})
