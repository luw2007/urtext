import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot } from '../src/review-ui.js'
import { renderConsolePage } from '../src/ui/render-console.js'
import type { StatusItem } from '../src/status.js'
import { scanWorkspace } from '../src/scanner.js'

let db: Database
let root: string

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  root = mkdtempSync(join(tmpdir(), 'urtext-impact-unmapped-'))
  git('init', '-q')
  git('config', 'user.email', 'test@urtext.dev')
  git('config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), '## C001 intent <!-- oracle:manual -->')
  writeFileSync(join(root, 'tracked.txt'), 'baseline')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
})

afterEach(() => {
  db.close()
  rmSync(root, { force: true, recursive: true })
})

describe('workspace unmapped impact', () => {
  test('reports hunks without assigning them to a clause', () => {
    writeFileSync(join(root, 'tracked.txt'), 'changed')
    const snapshot = buildUiSnapshot(db, root)
    expect(snapshot.unmapped).toEqual([{ filePath: 'tracked.txt', lineStart: 1, lineEnd: 1 }])
    expect(snapshot.unmappedError).toBeNull()
    expect(snapshot.status.items).toContainEqual(expect.objectContaining({ key: 'tracked.txt:1-1', kind: 'unmapped' }))
  })

  test('distinguishes a successful empty scan from scan failure', () => {
    const clean = buildUiSnapshot(db, root)
    expect(clean.unmapped).toEqual([])
    expect(clean.unmappedError).toBeNull()
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const failed = buildUiSnapshot(db, root)
    expect(failed.unmapped).toEqual([])
    expect(failed.unmappedError).toContain('git diff failed')
  })

  test('renders hunk and failure banners as separate escaped states', () => {
    const base = buildUiSnapshot(db, root)
    const item: StatusItem = {
      key: '<bad>.ts:2-3',
      kind: 'unmapped',
      lane: 'human',
      primary: 'unmapped',
      reasons: ['unmapped'],
      next: '`urtext map <spec>#<clause> <range>` | `urtext ack <range> <reason>` | write back to spec',
      filePath: '<bad>.ts',
      lineStart: 2,
      lineEnd: 3,
    }
    const unmapped = renderConsolePage({
      ...base,
      unmapped: [{ filePath: '<bad>.ts', lineStart: 2, lineEnd: 3 }],
      unmappedError: null,
      status: { ...base.status, items: [item] },
    }, 'tok')
    expect(unmapped).toContain('data-banner="unmapped">')
    expect(unmapped).toContain('&lt;bad&gt;.ts:2-3')
    expect(unmapped).toContain('urtext map &lt;spec&gt;#&lt;clause&gt; &lt;bad&gt;.ts:2-3')
    expect(unmapped).toContain('urtext ack &lt;bad&gt;.ts:2-3 &lt;reason&gt;')
    expect(unmapped).not.toContain('data-banner="unmapped-error"')

    const failed = renderConsolePage({ ...base, unmapped: [], unmappedError: '<git failed>' }, 'tok')
    expect(failed).toContain('data-banner="unmapped-error"')
    expect(failed).toContain('&lt;git failed&gt;')
    expect(failed).not.toContain('data-banner="unmapped">')
  })
})
