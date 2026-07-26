import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { importVerdicts, latestEvidence } from '../src/audit.js'
import { buildBrief, currentBriefHash } from '../src/brief.js'
import { recordMapping } from '../src/dwarf.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const makeRepo = (spec: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-brief-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), `## FR001 test intent\n\n${spec}`)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  return root
}

const KEY = { specPath: 'specs/x/spec.md', clauseId: 'C001' }

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('buildBrief manifest', () => {
  test('assembles clause row, evidence digest, audit state, and a 12-hex hash', () => {
    const root = makeRepo(
      [
        '## C001 pay guard <!-- oracle:cmd:true risk:high refs:specs/x/spec.md#C002 req:FR001 -->',
        'Reject stacked coupons on the apply path.',
        '## C002 base <!-- oracle:cmd:true req:FR001 -->',
      ].join('\n')
    )
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    for (const evidence of latestEvidence(db)) {
      importVerdicts(db, [{ evidenceId: evidence.id, auditor: 'codex', verdict: 'agree' }], 1)
    }
    const outcome = buildBrief(db, root, KEY)
    expect(outcome.kind).toBe('built')
    if (outcome.kind !== 'built') return
    expect(outcome.brief.manifest).toMatchObject({
      schema: 'urtext.brief/1',
      risk: 'high',
      oracleKind: 'cmd',
      refs: ['specs/x/spec.md#C002'],
      reqs: ['FR001'],
      stale: false,
      auditVerdict: 'agree',
    })
    expect(outcome.brief.manifest.body).toContain('Reject stacked coupons')
    expect(outcome.brief.manifest.evidence?.verdict).toBe('pass')
    expect(outcome.brief.manifest.evidence?.digest).toMatch(/^sha256:/)
    expect(outcome.brief.briefHash).toMatch(/^[0-9a-f]{12}$/)
  })

  test('ready-guard: a building revision gets no approvable hash', () => {
    const root = makeRepo('## C001 no oracle here\nbody')
    scanWorkspace(db, root)
    const outcome = buildBrief(db, root, KEY)
    expect(outcome).toMatchObject({ kind: 'refused', code: 'not_ready' })
    expect(currentBriefHash(db, root, KEY)).toBeNull()
  })

  test('link-guard: an unresolved ref gets no approvable hash', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true refs:specs/x/spec.md#C999 req:FR001 -->')
    scanWorkspace(db, root)
    const outcome = buildBrief(db, root, KEY)
    expect(outcome).toMatchObject({ kind: 'refused', code: 'link_error' })
  })

  test('unknown clause refuses', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true req:FR001 -->')
    scanWorkspace(db, root)
    expect(buildBrief(db, root, { ...KEY, clauseId: 'C999' })).toMatchObject({
      kind: 'refused',
      code: 'unknown_clause',
    })
  })
})

describe('brief-hash freshness semantics', () => {
  test('an identical re-verify keeps the hash stable (digest is content-based)', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true req:FR001 -->')
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    const first = currentBriefHash(db, root, KEY)
    verifyWorkspace(db, root) // appends a new evidence row, same content
    expect(currentBriefHash(db, root, KEY)).toBe(first)
  })

  test('an anchor-only risk change flips the hash (text_hash alone would not)', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true risk:high req:FR001 -->\nbody')
    scanWorkspace(db, root)
    const first = currentBriefHash(db, root, KEY)
    writeFileSync(join(root, 'specs/x/spec.md'), '## FR001 test intent\n\n## C001 t <!-- oracle:cmd:true req:FR001 -->\nbody')
    scanWorkspace(db, root)
    const second = currentBriefHash(db, root, KEY)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  test('mapped code content changes flip the hash', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true req:FR001 -->')
    writeFileSync(join(root, 'src.txt'), 'one\ntwo\nthree\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'code baseline')
    scanWorkspace(db, root)
    writeFileSync(join(root, 'src.txt'), 'one\nTWO CHANGED\nthree\n')
    const mapped = recordMapping(
      db,
      { ...KEY, filePath: 'src.txt', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    expect(mapped.kind).toBe('mapped')
    const first = currentBriefHash(db, root, KEY)
    writeFileSync(join(root, 'src.txt'), 'one\nTWO CHANGED AGAIN\nthree\n')
    const second = currentBriefHash(db, root, KEY)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    const outcome = buildBrief(db, root, KEY)
    if (outcome.kind === 'built') {
      expect(outcome.brief.manifest.mappings[0]?.content).toBe('TWO CHANGED AGAIN')
    }
  })

  test('mapped code includes only intersecting blame diff hunks from the mapping HEAD', () => {
    const root = makeRepo('## C001 t <!-- oracle:cmd:true req:FR001 -->')
    const baseline = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(root, 'src.txt'), baseline.join('\n') + '\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'code baseline')
    scanWorkspace(db, root)

    const changed = [...baseline]
    changed[1] = 'LINE TWO CHANGED'
    changed[10] = 'LINE ELEVEN UNRELATED'
    writeFileSync(join(root, 'src.txt'), changed.join('\n') + '\n')
    expect(recordMapping(
      db,
      { ...KEY, filePath: 'src.txt', lineStart: 2, lineEnd: 2 },
      root,
      1
    ).kind).toBe('mapped')

    const outcome = buildBrief(db, root, KEY)
    if (outcome.kind !== 'built') throw new Error('expected a brief')
    const mapping = outcome.brief.manifest.mappings[0]
    expect(mapping?.diff).toContain('-line 2')
    expect(mapping?.diff).toContain('+LINE TWO CHANGED')
    expect(mapping?.diff).not.toContain('LINE ELEVEN UNRELATED')
    expect(mapping?.diffError).toBeNull()
  })
})
