import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { impact, linkWorkspace, propagateStale, uncoveredRequirements } from '../src/linker.js'
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
  index('specs/billing/spec.md', '## FR001 intent\n## C001 结算不变量 <!-- oracle:manual req:FR001 -->\nbase')
  index(
    'specs/coupon/spec.md',
    '## FR001 intent\n## C001 不可叠加 <!-- oracle:manual refs:specs/billing/spec.md#C001 req:FR001 -->\nmid'
  )
  index(
    'specs/checkout/spec.md',
    '## FR001 intent\n## C001 下单校验 <!-- oracle:manual refs:specs/coupon/spec.md#C001 req:FR001 -->\ntop'
  )
}

describe('linkWorkspace', () => {
  test('missing bare and explicit requirements are unknown_req with a target', () => {
    index(
      'specs/coupon/spec.md',
      [
        '## C001 bare <!-- oracle:manual req:FR999 -->',
        '## C002 path <!-- oracle:manual req:specs/ghost/spec.md#FR001 -->',
      ].join('\n')
    )
    expect(linkWorkspace(db)).toEqual([
      expect.objectContaining({ code: 'unknown_req', clauseId: 'C001', target: 'FR999' }),
      expect.objectContaining({
        code: 'unknown_req',
        clauseId: 'C002',
        target: 'specs/ghost/spec.md#FR001',
      }),
    ])
  })

  test('a bare binding is ambiguous across same-unit files and never picks a winner', () => {
    index('specs/x/a.md', '## FR001 first')
    index('specs/x/b.md', '## FR001 second')
    index('specs/x/spec.md', '## C001 lock <!-- oracle:manual req:FR001 -->')
    expect(linkWorkspace(db)).toEqual([
      expect.objectContaining({ code: 'ambiguous_req', clauseId: 'C001', target: 'FR001' }),
    ])
    expect(uncoveredRequirements(db)).toEqual([
      { specPath: 'specs/x/a.md', reqId: 'FR001', title: 'first' },
      { specPath: 'specs/x/b.md', reqId: 'FR001', title: 'second' },
    ])
  })

  test('resolved cross-file refs produce no errors', () => {
    seedChain()
    expect(linkWorkspace(db)).toEqual([])
  })

  test('a ref to a missing clause or file is unknown_ref (fail-closed)', () => {
    index(
      'specs/coupon/spec.md',
      [
        '## FR001 intent',
        '## C001 引用缺失子句 <!-- oracle:manual refs:specs/billing/spec.md#C999 req:FR001 -->',
        '## C002 引用缺失文件 <!-- oracle:manual refs:specs/ghost/spec.md#C001 req:FR001 -->',
      ].join('\n')
    )
    index('specs/billing/spec.md', '## FR001 intent\n## C001 存在 <!-- oracle:manual req:FR001 -->')

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
    index('specs/billing/spec.md', '## FR001 intent\n## C002 改名了 <!-- oracle:manual req:FR001 -->', 2)
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
      .prepare('SELECT spec_path, invalidated_at, invalidation_source FROM evidence ORDER BY spec_path')
      .all() as { spec_path: string; invalidated_at: number | null; invalidation_source: string | null }[]
    expect(rows).toEqual([
      { spec_path: 'specs/billing/spec.md', invalidated_at: null, invalidation_source: null },
      {
        spec_path: 'specs/checkout/spec.md',
        invalidated_at: 99,
        invalidation_source: 'specs/billing/spec.md#C001',
      },
      {
        spec_path: 'specs/coupon/spec.md',
        invalidated_at: 99,
        invalidation_source: 'specs/billing/spec.md#C001',
      },
    ])
  })

  test('an FR text change stamps its bound clause and refs dependents', () => {
    index(
      'specs/billing/spec.md',
      '## FR001 intent\nv1\n## C001 base <!-- oracle:manual req:FR001 -->'
    )
    index(
      'specs/coupon/spec.md',
      '## FR001 downstream\n## C001 dep <!-- oracle:manual req:FR001 refs:specs/billing/spec.md#C001 -->'
    )
    insertEvidence('specs/billing/spec.md', 'C001')
    insertEvidence('specs/coupon/spec.md', 'C001')
    const changed = index(
      'specs/billing/spec.md',
      '## FR001 intent\nv2\n## C001 base <!-- oracle:manual req:FR001 -->',
      2
    )
    expect(changed.kind === 'indexed' && changed.changedClauses).toEqual([])
    const report = propagateStale(
      db,
      [],
      99,
      [{ specPath: 'specs/billing/spec.md', reqId: 'FR001' }]
    )
    expect(report.staleClauses).toEqual([
      { specPath: 'specs/billing/spec.md', clauseId: 'C001' },
      { specPath: 'specs/coupon/spec.md', clauseId: 'C001' },
    ])
    expect(report.invalidatedEvidence).toBe(2)
    expect(
      db
        .prepare('SELECT spec_path, invalidation_source FROM evidence WHERE invalidated_at = 99 ORDER BY spec_path')
        .all()
    ).toEqual([
      { spec_path: 'specs/billing/spec.md', invalidation_source: 'specs/billing/spec.md#FR001' },
      { spec_path: 'specs/coupon/spec.md', invalidation_source: 'specs/billing/spec.md#FR001' },
    ])
  })

  test('removed FRs match old raw keys and invalidate bound evidence', () => {
    index('specs/x/spec.md', '## FR001 intent\n## C001 lock <!-- oracle:manual req:FR001 -->')
    insertEvidence('specs/x/spec.md', 'C001')
    const removed = index('specs/x/spec.md', '## C001 lock <!-- oracle:manual req:FR001 -->', 2)
    expect(removed.kind === 'indexed' && removed.changedRequirements).toEqual(['FR001'])
    expect(linkWorkspace(db)).toEqual([
      expect.objectContaining({ code: 'unknown_req', clauseId: 'C001' }),
    ])
    const report = propagateStale(
      db,
      [],
      99,
      [{ specPath: 'specs/x/spec.md', reqId: 'FR001' }]
    )
    expect(report.staleClauses).toEqual([{ specPath: 'specs/x/spec.md', clauseId: 'C001' }])
    expect(report.invalidatedEvidence).toBe(1)
  })

  test('a simultaneous clause and bound-FR edit attributes self to FR and downstream to clause', () => {
    index(
      'specs/x/spec.md',
      '## FR001 intent\nv1\n## C001 lock <!-- oracle:manual req:FR001 -->\nclause v1\n## C002 dep <!-- oracle:manual refs:specs/x/spec.md#C001 req:FR001 -->'
    )
    insertEvidence('specs/x/spec.md', 'C001')
    insertEvidence('specs/x/spec.md', 'C002')
    const changed = index(
      'specs/x/spec.md',
      '## FR001 intent\nv2\n## C001 lock <!-- oracle:manual req:FR001 -->\nclause v2\n## C002 dep <!-- oracle:manual refs:specs/x/spec.md#C001 req:FR001 -->',
      2
    )
    expect(changed.kind).toBe('indexed')
    if (changed.kind !== 'indexed') return
    const report = propagateStale(
      db,
      changed.changedClauses.map((clauseId) => ({ specPath: 'specs/x/spec.md', clauseId })),
      99,
      changed.changedRequirements.map((reqId) => ({ specPath: 'specs/x/spec.md', reqId }))
    )
    expect(report.staleClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C001' },
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
    ])
    expect(report.invalidatedEvidence).toBe(2)
    expect(
      db
        .prepare('SELECT clause_id, invalidated_at, invalidation_source FROM evidence ORDER BY clause_id')
        .all()
    ).toEqual([
      { clause_id: 'C001', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#FR001' },
      { clause_id: 'C002', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#C001' },
    ])
  })

  test('keeps the first labelled root at a C+FR collision and stamps both columns', () => {
    index(
      'specs/x/spec.md',
      [
        '## FR001 defended intent',
        '## FR002 independent intent',
        '## C001 earlier root <!-- oracle:manual req:FR002 -->',
        '## C002 changed defender <!-- oracle:manual req:FR001 -->',
        '## C003 collision descendant <!-- oracle:manual refs:specs/x/spec.md#C001,specs/x/spec.md#C002 req:FR002 -->',
      ].join('\n')
    )
    insertEvidence('specs/x/spec.md', 'C002')
    insertEvidence('specs/x/spec.md', 'C003')

    const report = propagateStale(
      db,
      [
        { specPath: 'specs/x/spec.md', clauseId: 'C001' },
        { specPath: 'specs/x/spec.md', clauseId: 'C002' },
      ],
      99,
      [{ specPath: 'specs/x/spec.md', reqId: 'FR001' }]
    )

    expect(report.staleClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
      { specPath: 'specs/x/spec.md', clauseId: 'C003' },
    ])
    expect(report.invalidatedEvidence).toBe(2)
    expect(
      db
        .prepare('SELECT clause_id, invalidated_at, invalidation_source FROM evidence ORDER BY clause_id')
        .all()
    ).toEqual([
      { clause_id: 'C002', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#FR001' },
      { clause_id: 'C003', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#C001' },
    ])
  })

  test('uses incoming changed-clause order to break C+FR collision ties', () => {
    index(
      'specs/x/spec.md',
      [
        '## FR001 defended intent',
        '## FR002 independent intent',
        '## C001 later root <!-- oracle:manual req:FR002 -->',
        '## C002 earlier changed defender <!-- oracle:manual req:FR001 -->',
        '## C003 collision descendant <!-- oracle:manual refs:specs/x/spec.md#C001,specs/x/spec.md#C002 req:FR002 -->',
      ].join('\n')
    )
    insertEvidence('specs/x/spec.md', 'C002')
    insertEvidence('specs/x/spec.md', 'C003')

    const report = propagateStale(
      db,
      [
        { specPath: 'specs/x/spec.md', clauseId: 'C002' },
        { specPath: 'specs/x/spec.md', clauseId: 'C001' },
      ],
      99,
      [{ specPath: 'specs/x/spec.md', reqId: 'FR001' }]
    )

    expect(report.staleClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
      { specPath: 'specs/x/spec.md', clauseId: 'C003' },
    ])
    expect(report.invalidatedEvidence).toBe(2)
    expect(
      db
        .prepare('SELECT clause_id, invalidated_at, invalidation_source FROM evidence ORDER BY clause_id')
        .all()
    ).toEqual([
      { clause_id: 'C002', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#FR001' },
      { clause_id: 'C003', invalidated_at: 99, invalidation_source: 'specs/x/spec.md#C002' },
    ])
  })

  test('preserves the first two-column stamp when a later cause reaches the same evidence', () => {
    index(
      'specs/x/spec.md',
      [
        '## FR001 defended intent',
        '## C001 defender <!-- oracle:manual req:FR001 -->',
        '## C002 dependent <!-- oracle:manual refs:specs/x/spec.md#C001 req:FR001 -->',
      ].join('\n')
    )
    insertEvidence('specs/x/spec.md', 'C002')

    const first = propagateStale(db, [], 99, [{ specPath: 'specs/x/spec.md', reqId: 'FR001' }])
    const second = propagateStale(db, [{ specPath: 'specs/x/spec.md', clauseId: 'C001' }], 100)

    expect(first.staleClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C001' },
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
    ])
    expect(first.invalidatedEvidence).toBe(1)
    expect(second.staleClauses).toEqual([{ specPath: 'specs/x/spec.md', clauseId: 'C002' }])
    expect(second.invalidatedEvidence).toBe(0)
    expect(
      db
        .prepare('SELECT invalidated_at, invalidation_source FROM evidence WHERE clause_id = ?')
        .get('C002')
    ).toEqual({ invalidated_at: 99, invalidation_source: 'specs/x/spec.md#FR001' })
  })

  test('never backfills a legacy NULL source on already stale evidence', () => {
    index(
      'specs/x/spec.md',
      [
        '## FR001 defended intent',
        '## C001 source <!-- oracle:manual req:FR001 -->',
        '## C002 dependent <!-- oracle:manual refs:specs/x/spec.md#C001 req:FR001 -->',
      ].join('\n')
    )
    insertEvidence('specs/x/spec.md', 'C002')
    db.prepare('UPDATE evidence SET invalidated_at = ? WHERE clause_id = ?').run(7, 'C002')

    const report = propagateStale(db, [{ specPath: 'specs/x/spec.md', clauseId: 'C001' }], 99)

    expect(report.staleClauses).toEqual([{ specPath: 'specs/x/spec.md', clauseId: 'C002' }])
    expect(report.invalidatedEvidence).toBe(0)
    expect(
      db
        .prepare('SELECT invalidated_at, invalidation_source FROM evidence WHERE clause_id = ?')
        .get('C002')
    ).toEqual({ invalidated_at: 7, invalidation_source: null })
  })

  test('no changed clauses is a no-op', () => {
    seedChain()
    expect(propagateStale(db, [], 99)).toEqual({ staleClauses: [], invalidatedEvidence: 0 })
  })

  test('a ref cycle terminates and marks both sides', () => {
    index(
      'specs/a/spec.md',
      '## FR001 intent\n## C001 甲 <!-- oracle:manual refs:specs/b/spec.md#C001 req:FR001 -->'
    )
    index(
      'specs/b/spec.md',
      '## FR001 intent\n## C001 乙 <!-- oracle:manual refs:specs/a/spec.md#C001 req:FR001 -->'
    )
    const report = propagateStale(db, [{ specPath: 'specs/a/spec.md', clauseId: 'C001' }], 99)
    expect(report.staleClauses).toEqual([{ specPath: 'specs/b/spec.md', clauseId: 'C001' }])
  })
})

describe('uncoveredRequirements', () => {
  test('reports only live FRs with no uniquely resolved binding', () => {
    index(
      'specs/x/spec.md',
      ['## FR001 covered', '## FR002 uncovered', '## C001 lock <!-- oracle:manual req:FR001 -->'].join('\n')
    )
    expect(uncoveredRequirements(db)).toEqual([
      { specPath: 'specs/x/spec.md', reqId: 'FR002', title: 'uncovered' },
    ])
  })
})

describe('scanWorkspace link pass', () => {
  test('editing a clause body invalidates downstream evidence across scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-link-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/billing'), { recursive: true })
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(join(root, 'specs/billing/spec.md'), '## FR001 intent\n## C001 基座 <!-- oracle:manual req:FR001 -->\nv1')
    writeFileSync(
      join(root, 'specs/coupon/spec.md'),
      '## FR001 intent\n## C001 依赖方 <!-- oracle:manual refs:specs/billing/spec.md#C001 req:FR001 -->'
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

    writeFileSync(join(root, 'specs/billing/spec.md'), '## FR001 intent\n## C001 基座 <!-- oracle:manual req:FR001 -->\nv2')
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
      '## FR001 intent\n## C001 悬空引用 <!-- oracle:manual refs:specs/ghost/spec.md#C001 req:FR001 -->'
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
