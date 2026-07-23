import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

const makeWorkspace = (specContent: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-failclosed-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), specContent)
  return root
}

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('fail-closed rescan of building specs', () => {
  test('an unchanged building file keeps status building and re-reports its errors', () => {
    // Space in a cmd oracle value → malformed_anchor → building.
    const root = makeWorkspace('## C001 broken <!-- oracle:cmd:node scripts/x.mjs -->\n')

    const first = scanWorkspace(db, root).outcomes[0]!.outcome
    expect(first).toMatchObject({ kind: 'indexed', status: 'building' })

    // Second scan with identical content used to report bare `unchanged`,
    // letting `verify` treat a broken spec as green (the fail-open bug).
    const second = scanWorkspace(db, root).outcomes[0]!.outcome
    expect(second.kind).toBe('unchanged')
    if (second.kind !== 'unchanged') return
    expect(second.status).toBe('building')
    expect(second.errors?.some((error) => error.code === 'malformed_anchor')).toBe(true)
  })

  test('a building spec exposes no ready clauses to verify', () => {
    const root = makeWorkspace('## C001 broken <!-- oracle:cmd:node scripts/x.mjs -->\n')
    scanWorkspace(db, root)
    scanWorkspace(db, root)
    expect(verifyWorkspace(db, root).verdicts).toHaveLength(0)
  })
})

describe('single-clause verify and evidence duration', () => {
  const TWO_CLAUSES = ['## C001 a <!-- oracle:cmd:true -->', '', '## C002 b <!-- oracle:cmd:true -->', ''].join('\n')

  test('the only-filter runs exactly the targeted clause', () => {
    const root = makeWorkspace(TWO_CLAUSES)
    scanWorkspace(db, root)
    const report = verifyWorkspace(db, root, { specPath: 'specs/x/spec.md', clauseId: 'C002' })
    expect(report.verdicts.map((verdict) => verdict.clauseId)).toEqual(['C002'])
    const rows = db.prepare('SELECT clause_id FROM evidence').all() as { clause_id: string }[]
    expect(rows.map((row) => row.clause_id)).toEqual(['C002'])
  })

  test('a non-matching target yields an empty report, not a full run', () => {
    const root = makeWorkspace(TWO_CLAUSES)
    scanWorkspace(db, root)
    expect(verifyWorkspace(db, root, { specPath: 'specs/x/spec.md', clauseId: 'C999' }).verdicts).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 })
  })

  test('evidence rows record oracle duration_ms', () => {
    const root = makeWorkspace(TWO_CLAUSES)
    scanWorkspace(db, root)
    const report = verifyWorkspace(db, root)
    expect(report.verdicts.every((verdict) => verdict.durationMs >= 0)).toBe(true)
    const rows = db.prepare('SELECT duration_ms FROM evidence').all() as { duration_ms: number | null }[]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => typeof row.duration_ms === 'number' && row.duration_ms >= 0)).toBe(true)
  })
})
