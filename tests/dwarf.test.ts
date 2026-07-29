import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  blame,
  detectUnmapped,
  diffHunks,
  ensureCodeMap,
  recordAck,
  recordMapping,
} from '../src/dwarf.js'
import { run } from '../src/cli.js'
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
    ['## FR001 test intent', '## C001 不可叠加 <!-- oracle:manual req:FR001 -->', '## C002 结算 <!-- oracle:manual req:FR001 -->'].join('\n')
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

  test('reports the full new-side range of an untracked text file', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/new.ts'), ['const first = 1', 'const second = 2', ''].join('\n'))

    const result = diffHunks(root)

    expect('hunks' in result && result.hunks).toEqual([
      { filePath: 'src/new.ts', lineStart: 1, lineEnd: 2 },
    ])
  })

  test('ignores tool-generated .urtext state even when the fixture does not gitignore it', () => {
    const root = setupRepo()
    mkdirSync(join(root, '.urtext'), { recursive: true })
    writeFileSync(join(root, '.urtext/registry.sqlite'), 'tool state')
    writeFileSync(join(root, '.urtext/registry.sqlite-wal'), 'tool state')

    const result = diffHunks(root)

    expect('hunks' in result && result.hunks).toEqual([])
  })

  test('reports a sentinel range when a tracked binary diff has no textual hunk', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/blob.bin'), Buffer.from([0, 1, 2]))
    git(root, 'add', 'src/blob.bin')
    git(root, 'commit', '-q', '-m', 'add binary fixture')
    writeFileSync(join(root, 'src/blob.bin'), Buffer.from([0, 1, 3]))

    const result = diffHunks(root)

    expect('hunks' in result && result.hunks).toEqual([
      { filePath: 'src/blob.bin', lineStart: 1, lineEnd: 1 },
    ])
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

  test('CLI check --diff exits 1 for a dirty tracked unmapped change in text and JSON modes', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))

    const previous = process.cwd()
    try {
      process.chdir(root)
      expect(run(['check', '--diff'])).toBe(1)
      expect(run(['check', '--diff', '--json'])).toBe(1)
    } finally {
      process.chdir(previous)
    }
  })

  test('CLI check --diff does not report its own unignored .urtext registry as a code change', () => {
    const root = setupRepo()

    const previous = process.cwd()
    try {
      process.chdir(root)
      expect(run(['check', '--diff'])).toBe(0)
    } finally {
      process.chdir(previous)
    }
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

  test('retargeting an untracked symlink invalidates its same-HEAD ack', () => {
    const root = setupRepo()
    const link = join(root, 'src/current.ts')
    symlinkSync('missing-first.ts', link)
    const acked = recordAck(
      db,
      { filePath: 'src/current.ts', lineStart: 1, lineEnd: 1, note: 'first link target' },
      root,
      1
    )
    expect(acked.kind).toBe('acked')

    rmSync(link)
    symlinkSync('missing-second.ts', link)

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/current.ts', lineStart: 1, lineEnd: 1 },
    ])
  })

  test('replacing an acked symlink with a binary regular file invalidates its same-HEAD ack', () => {
    const root = setupRepo()
    const link = join(root, 'src/current.ts')
    const target = 'missing-first.ts'
    symlinkSync(target, link)
    const acked = recordAck(
      db,
      { filePath: 'src/current.ts', lineStart: 1, lineEnd: 1, note: 'link only' },
      root,
      1
    )
    expect(acked.kind).toBe('acked')

    rmSync(link)
    writeFileSync(link, Buffer.from(`symlink\0${target}`))

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/current.ts', lineStart: 1, lineEnd: 1 },
    ])
  })

  test('a pre-format legacy fingerprint cannot attribute a colliding upgraded hunk', () => {
    const root = setupRepo()
    const currentContent = Buffer.from('current content')
    writeFileSync(join(root, 'src/legacy.bin'), currentContent)

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    expect(head.status).toBe(0)
    // The legacy algorithm hashed content without a domain or format version.
    // This old content therefore collides with the domain-separated hash of currentContent.
    const legacyContent = Buffer.concat([Buffer.from('regular\0'), currentContent])
    const legacyFingerprint = createHash('sha256').update(legacyContent).digest('hex')
    ensureCodeMap(db)
    db.prepare(
      `INSERT INTO clause_code_map
         (kind, file_path, line_start, line_end, commit_sha, diff_fingerprint, note, created_at)
       VALUES ('ack', ?, ?, ?, ?, ?, ?, ?)`
    ).run('src/legacy.bin', 1, 1, head.stdout.trim(), legacyFingerprint, 'legacy row', 1)

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/legacy.bin', lineStart: 1, lineEnd: 1 },
    ])
  })

  test('rejects provenance when a status-only regular file cannot be read', () => {
    const root = setupRepo()
    const path = join(root, 'src/unreadable.bin')
    writeFileSync(path, Buffer.from([0, 1, 2]))
    chmodSync(path, 0o000)

    try {
      const outcome = recordAck(
        db,
        { filePath: 'src/unreadable.bin', lineStart: 1, lineEnd: 1, note: 'unreadable' },
        root,
        1
      )
      expect(outcome).toMatchObject({ kind: 'rejected', code: 'git_failed' })
    } finally {
      chmodSync(path, 0o600)
    }
  })

  test('rejects provenance when a status-only path is missing at fingerprint time', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/empty.bin'), '')
    git(root, 'add', 'src/empty.bin')
    git(root, 'commit', '-q', '-m', 'add empty fixture')
    rmSync(join(root, 'src/empty.bin'))

    const outcome = recordAck(
      db,
      { filePath: 'src/empty.bin', lineStart: 1, lineEnd: 1, note: 'missing' },
      root,
      1
    )

    expect(outcome).toMatchObject({ kind: 'rejected', code: 'git_failed' })
  })

  test('a later same-HEAD edit at identical coordinates invalidates a prior mapping', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const mapped = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    expect(mapped.kind).toBe('mapped')

    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 200', 'const c = 3', ''].join('\n'))

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
    ])
  })

  test('a later same-HEAD edit at identical coordinates invalidates a prior ack', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const acked = recordAck(
      db,
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2, note: 'first edit only' },
      root,
      1
    )
    expect(acked.kind).toBe('acked')

    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 200', 'const c = 3', ''].join('\n'))

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 2, lineEnd: 2 },
    ])
  })

  test('an oversized same-HEAD mapping does not swallow a later separate edit', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const mapped = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'src/impl.ts', lineStart: 1, lineEnd: 999 },
      root,
      1
    )
    expect(mapped.kind).toBe('mapped')

    writeFileSync(
      join(root, 'src/impl.ts'),
      ['const a = 1', 'const b = 20', 'const c = 3', 'const d = 4', ''].join('\n')
    )

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 4, lineEnd: 4 },
    ])
  })

  test('an oversized same-HEAD ack does not swallow a later separate edit', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'src/impl.ts'), ['const a = 1', 'const b = 20', 'const c = 3', ''].join('\n'))
    const acked = recordAck(
      db,
      { filePath: 'src/impl.ts', lineStart: 1, lineEnd: 999, note: 'bounded ack' },
      root,
      1
    )
    expect(acked.kind).toBe('acked')

    writeFileSync(
      join(root, 'src/impl.ts'),
      ['const a = 1', 'const b = 20', 'const c = 3', 'const d = 4', ''].join('\n')
    )

    const result = detectUnmapped(db, root)
    expect('unmapped' in result && result.unmapped).toEqual([
      { filePath: 'src/impl.ts', lineStart: 4, lineEnd: 4 },
    ])
  })

  test('editing a spec file IS the attribution (write-back)', () => {
    const root = setupRepo()
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      ['## FR001 test intent', '## C001 不可叠加 <!-- oracle:manual req:FR001 -->', '## C002 结算 <!-- oracle:manual req:FR001 -->', '新增说明'].join('\n')
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
