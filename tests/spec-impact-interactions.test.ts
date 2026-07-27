import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot, handleBrief } from '../src/review-ui.js'
import { renderConsoleFamilyPage } from '../src/ui/render-console.js'
import { renderBriefPage } from '../src/ui/render-brief.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
let root: string

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  root = mkdtempSync(join(tmpdir(), 'urtext-impact-interactions-'))
  git('init', '-q')
  git('config', 'user.email', 'test@urtext.dev')
  git('config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), [
    '## FR001 test intent',
    '## C001 base <!-- oracle:cmd:true req:FR001 -->',
    '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR001 -->',
  ].join('\n'))
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
})

afterEach(() => {
  db.close()
  rmSync(root, { force: true, recursive: true })
})

describe('complete spec impact interactions', () => {
  test('console browses every live clause even when it is absent from queues', () => {
    const snapshot = buildUiSnapshot(db, root)
    snapshot.status.items = []
    const renderPage = (page: number): string => renderConsoleFamilyPage({
      route: 'specs',
      snapshot,
      csrfToken: 'tok',
      page,
      pageSize: 1,
    })
    const first = renderPage(1)
    expect(first).toContain('id="all-specs"')
    expect(first).toContain('data-clause="specs/x/spec.md#C001"')
    expect(first).toContain('/brief?spec=specs%2Fx%2Fspec.md&amp;clause=C001')
    expect(first).toContain('刷新状态')
    const rows = [first, renderPage(2)].flatMap((html) => [...html.matchAll(/data-clause="([^"]+)"/g)].map((match) => match[1]!))
    expect(rows).toEqual(snapshot.clauses.map((clause) => `${clause.specPath}#${clause.clauseId}`))
    expect(new Set(rows).size).toBe(rows.length)
  })

  test('detail exposes stale dependents, refresh, and all-spec navigation', () => {
    db.prepare('UPDATE evidence SET invalidated_at = 1 WHERE spec_path = ? AND clause_id = ?').run('specs/x/spec.md', 'C002')
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in result.body)) throw new Error('expected a brief')
    const html = renderBriefPage({
      text: result.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C001',
      briefHash: result.body.briefHash,
      reviewable: false,
      facts: result.body.facts,
      view: result.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(result.body.view.dependents).toContainEqual(expect.objectContaining({ clauseId: 'C002', stale: true }))
    expect(html).toContain('data-state="dependent-stale"')
    expect(html).toContain('查看全部 Specs')
    expect(html).toContain('刷新状态')
  })

  test('detail renders escaped mapped blame diff content', () => {
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in result.body)) throw new Error('expected a brief')
    result.body.view.mappings.push({
      filePath: 'src/<impl>.ts',
      lineStart: 2,
      lineEnd: 2,
      commitSha: 'abcdef0',
      note: null,
      content: 'new',
      diff: '@@ -2 +2 @@\n-const old = "<unsafe>"\n+const next = 1',
      diffError: null,
    })
    const html = renderBriefPage({
      text: result.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C001',
      briefHash: result.body.briefHash,
      reviewable: false,
      facts: result.body.facts,
      view: result.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(html).toContain('data-section="blame-diff"')
    expect(html).toContain('src/&lt;impl&gt;.ts:2-2')
    expect(html).toContain('-const old = &quot;&lt;unsafe&gt;&quot;')
    expect(html).not.toContain('<unsafe>')
  })
})
