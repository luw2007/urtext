import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { recordMapping } from '../src/dwarf.js'
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
    '## C001 base <!-- oracle:cmd:true risk:high req:FR001 -->',
    '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR001 -->',
  ].join('\n'))
  writeFileSync(join(root, 'specs/x/tasks.md'), '- [ ] T001 inspect impact <!-- clauses:C002 -->')
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

  test('detail renders risk, current evidence staleness, potential impact, and no mapping from registry facts', () => {
    writeFileSync(join(root, 'specs/x/spec.md'), [
      '## FR001 changed test intent',
      '## C001 base <!-- oracle:cmd:true risk:high req:FR001 -->',
      '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR001 -->',
    ].join('\n'))
    scanWorkspace(db, root)
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

    expect(result.body.view).toMatchObject({
      risk: 'high',
      stale: true,
      hasEvidence: false,
      mappings: [],
    })
    expect(result.body.view.dependents).toContainEqual(expect.objectContaining({
      clauseId: 'C002',
      stale: true,
      evidenceVerdict: 'missing',
    }))
    expect(result.body.view.impact.affectedClauses).toEqual([
      { specPath: 'specs/x/spec.md', clauseId: 'C002' },
    ])
    expect(result.body.view.impact.affectedTasks).toContainEqual(
      expect.objectContaining({ specPath: 'specs/x/tasks.md', fileId: 'T001', clauseId: 'C002' })
    )
    expect(html).toContain('data-state="risk-high"')
    expect(html).toContain('data-state="stale"')
    expect(html).toContain('1 个关联任务')
    expect(html).toContain('尚无映射代码')
    expect(html).toContain('urtext map &lt;spec&gt;#&lt;clause&gt;')
  })

  test('detail shows the real no-change and diff-failure states for recorded mappings', () => {
    writeFileSync(join(root, 'mapped.ts'), 'one\ntwo\nthree\n')
    git('add', 'mapped.ts')
    git('commit', '-qm', 'mapping baseline')
    writeFileSync(join(root, 'mapped.ts'), 'one\nTWO CHANGED\nthree\n')
    expect(recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'mapped.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    ).kind).toBe('mapped')
    git('reset', '--hard', 'HEAD')

    const unchanged = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in unchanged.body)) throw new Error('expected a brief')
    const unchangedHtml = renderBriefPage({
      text: unchanged.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C001',
      briefHash: unchanged.body.briefHash,
      reviewable: false,
      facts: unchanged.body.facts,
      view: unchanged.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(unchanged.body.view.mappings[0]).toMatchObject({ diff: null, diffError: null })
    expect(unchangedHtml).toContain('data-section="blame-diff-empty"')

    writeFileSync(join(root, 'mapped.ts'), 'one\nTWO CHANGED AGAIN\nthree\n')
    expect(recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'mapped.ts', lineStart: 2, lineEnd: 2 },
      root,
      2
    ).kind).toBe('mapped')
    rmSync(join(root, '.git'), { force: true, recursive: true })

    const failed = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in failed.body)) throw new Error('expected a brief')
    const failedHtml = renderBriefPage({
      text: failed.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C001',
      briefHash: failed.body.briefHash,
      reviewable: false,
      facts: failed.body.facts,
      view: failed.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(failed.body.view.mappings[0]?.diff).toBeNull()
    expect(failed.body.view.mappings[0]?.diffError).not.toBeNull()
    expect(failedHtml).toContain('data-section="blame-diff-error"')
  })

  test('detail renders only intersecting hunk content from a real mapping HEAD to the worktree', () => {
    const baseline = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    writeFileSync(join(root, 'mapped.ts'), `${baseline.join('\n')}\n`)
    git('add', 'mapped.ts')
    git('commit', '-qm', 'mapping baseline')
    const changed = [...baseline]
    changed[1] = 'LINE TWO CHANGED'
    changed[18] = 'LINE NINETEEN UNRELATED'
    writeFileSync(join(root, 'mapped.ts'), `${changed.join('\n')}\n`)
    const mapped = recordMapping(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', filePath: 'mapped.ts', lineStart: 2, lineEnd: 2 },
      root,
      1
    )
    if (mapped.kind !== 'mapped') throw new Error('expected a real mapping')

    const result = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in result.body)) throw new Error('expected a brief')
    const mapping = result.body.view.mappings[0]
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

    expect(mapping?.commitSha).toBe(mapped.commitSha)
    expect(mapping?.diff).toContain('-line 2')
    expect(mapping?.diff).toContain('+LINE TWO CHANGED')
    expect(mapping?.diff).not.toContain('LINE NINETEEN UNRELATED')
    expect(mapping?.diffError).toBeNull()
    expect(html).toContain('data-section="blame-diff"')
    expect(html).toContain('+LINE TWO CHANGED')
  })
})
