import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { run } from '../src/cli.js'
import { impactRequirement, linkWorkspace } from '../src/linker.js'
import { indexClauseFile, indexTaskFile, openRegistry } from '../src/registry.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('impactRequirement', () => {
  test('sorts direct defenders, includes them in the reverse closure, and projects tasks', () => {
    const db = new DatabaseConstructor(':memory:')
    openRegistry(db)
    indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: [
        '## FR001 target intent',
        '## FR002 downstream intent',
        '## C002 second defender <!-- oracle:manual req:FR001 -->',
        '## C001 first defender <!-- oracle:manual req:FR001 -->',
        '## C003 dependent <!-- oracle:manual refs:specs/x/spec.md#C001 req:FR002 -->',
      ].join('\n'),
      timestamp: 1,
    })
    indexTaskFile(db, {
      specPath: 'specs/x/tasks.md',
      content: '- [ ] T001 exercise impact <!-- clauses:C001,C003 -->',
      timestamp: 1,
      unitClauseIds: new Set(['C001', 'C002', 'C003']),
    })

    const outcome = impactRequirement(db, { specPath: 'specs/x/spec.md', reqId: 'FR001' })
    expect(outcome.kind).toBe('found')
    if (outcome.kind !== 'found') return
    expect(outcome.report.directClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C001' },
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
    ])
    expect(outcome.report.affectedClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C001' },
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
      { specPath: 'specs/x/spec.md', clauseId: 'C003' },
    ])
    expect(outcome.report.affectedTasks.map((task) => task.clauseId)).toEqual(['C001', 'C003'])
    expect(impactRequirement(db, { specPath: 'specs/x/spec.md', reqId: 'FR999' })).toEqual({
      kind: 'unknown_requirement',
      target: { specPath: 'specs/x/spec.md', reqId: 'FR999' },
    })
    db.close()
  })

  test('does not treat an ambiguous bare req edge as a direct defender', () => {
    const db = new DatabaseConstructor(':memory:')
    openRegistry(db)
    indexClauseFile(db, { specPath: 'specs/x/a.md', content: '## FR001 first', timestamp: 1 })
    indexClauseFile(db, { specPath: 'specs/x/b.md', content: '## FR001 second', timestamp: 1 })
    indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## C001 ambiguous <!-- oracle:manual req:FR001 -->',
      timestamp: 1,
    })
    expect(linkWorkspace(db)).toEqual([
      expect.objectContaining({ code: 'ambiguous_req', clauseId: 'C001' }),
    ])
    const outcome = impactRequirement(db, { specPath: 'specs/x/a.md', reqId: 'FR001' })
    expect(outcome.kind === 'found' && outcome.report.directClauses).toEqual([])
    db.close()
  })
})

describe('importable CLI run', () => {
  test('executes FR, unknown-FR, syntax, and byte-pinned clause paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-fr-impact-'))
    roots.push(root)
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      [
        '## FR001 target intent',
        '## FR002 undefended intent',
        '## C001 defender <!-- oracle:cmd:true req:FR001 -->',
        '## C002 leaf <!-- oracle:cmd:true req:FR001 -->',
      ].join('\n')
    )
    const logs: string[] = []
    const errors: string[] = []
    vi.spyOn(console, 'log').mockImplementation((value) => logs.push(String(value)))
    vi.spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)))
    const previous = process.cwd()
    try {
      process.chdir(root)
      expect(run(['impact', 'specs/x/spec.md#FR001'])).toBe(0)
      expect(logs).toEqual([
        'Affected clauses (direct + reverse closure):',
        '  [direct] specs/x/spec.md#C001',
        '  [direct] specs/x/spec.md#C002',
      ])
      logs.length = 0
      expect(run(['impact', 'specs/x/spec.md#C002'])).toBe(0)
      expect(logs).toEqual(['No clause refs specs/x/spec.md#C002 and no task cites it.'])
      expect(run(['impact', 'specs/x/spec.md#FR999'])).toBe(1)
      expect(errors.at(-1)).toContain('No live requirement specs/x/spec.md#FR999')
      expect(run(['impact', 'specs/x/spec.md#FR1x'])).toBe(1)
      expect(errors.at(-1)).toContain('<spec-path>#FR<n>')
      logs.length = 0
      expect(run(['impact', 'specs/x/spec.md#FR002'])).toBe(0)
      expect(logs).toEqual(['Affected clauses (direct + reverse closure): none'])
    } finally {
      process.chdir(previous)
    }
  })
})
