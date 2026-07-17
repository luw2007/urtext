import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { blame, detectUnmapped, diffHunks, recordAck, recordMapping } from '../src/dwarf.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A git repo with specs/x/spec.md (2 clauses) + src/impl.ts, one baseline commit. */
const setupRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-dwarf-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'specs/x/spec.md'),
    ['## C001 不可叠加 <!-- oracle:manual -->', '## C002 结算 <!-- oracle:manual -->'].join('\n')
  )
  writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 2', 'const c = 3', ''].join('\n'))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
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

describe('diffHunks', () => {
  test('reports new-side ranges for a working-tree edit', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const result = diffHunks(root)
    expect('hunks' in result && result.hunks).toEqual([
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
    ])
  })

  test('a clean tree yields no hunks', () => {
    const root = setupRepo()
    const result = diffHunks(root)
    expect('hunks' in result && result.hunks).toEqual([])
  })
})

describe('recordMapping', () => {
  test('persists a mapping only when the claimed range hits a real diff hunk', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))

    const outcome = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    expect(outcome.kind).toBe('mapped')
  })

  test('rejects a claim whose range does not intersect any change (trust diff, not claim)', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))

    const outcome = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 3, lineEnd: 3 },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'unverified_range' })
  })

  test('rejects a claim to a clause not live in the registry', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))

    const outcome = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C999', filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'unknown_clause' })
  })
})

describe('detectUnmapped', () => {
  test('a code change with no mapping, ack, or spec write-back is unmapped', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
    ])
  })

  test('a mapped change is attributed and no longer unmapped', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([])
  })

  test('an explicit ack attributes an intentionally unmapped change', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const ack = recordAck(
      db,
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2, note: 'typo fix, no behavior change' },
      root,
      1
    )
    expect(ack.kind).toBe('acked')
    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([])
  })

  test('editing a spec file IS the attribution (write-back)', () => {
    const root = setupRepo()
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      ['## C001 不可叠加 <!-- oracle:manual -->', '## C002 结算 <!-- oracle:manual -->', '新增说明'].join('\n')
    )
    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([])
  })

  test('a mapping recorded at a different HEAD does not attribute the current change', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    // New commit moves HEAD; the old mapping describes a stale code state.
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'land change')
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 30', ''].join('\n'))

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 3, lineEnd: 3 },
    ])
  })
})

describe('blame', () => {
  test('reports the clause constraining a mapped line', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    recordMapping(
      db,
      {
        specPath: 'specs/x/spec.md',
        clauseId: 'C001',
        filePath: 'src/impl.ts',
        lineStart: 2,
        lineEnd: 2,
        note: 'stacking guard',
      },
      root,
      1
    )
    const entries = blame(db, 'src/impl.ts', 2)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      specPath: 'specs/x/spec.md',
      clauseId: 'C001',
      note: 'stacking guard',
    })
  })

  test('an unmapped line has no blame', () => {
    const root = setupRepo()
    expect(blame(db, 'src/impl.ts', 99)).toEqual([])
  })
})
