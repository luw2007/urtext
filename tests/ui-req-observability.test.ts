import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { indexClauseFile, openRegistry } from '../src/registry.js'
import { handleBrief, type UiSnapshot } from '../src/review-ui.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { renderBriefErrorPage, renderBriefPage } from '../src/ui/render-brief.js'
import { renderConsoleFamilyPage } from '../src/ui/render-console.js'

let db: Database
let root: string

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  root = mkdtempSync(join(tmpdir(), 'urtext-ui-req-'))
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('requirement binding projection', () => {
  test('preserves clauses.reqs source order and renders resolved key/title', () => {
    indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: [
        '## FR001 first intent',
        '## FR002 second intent',
        '## C001 guarded <!-- oracle:cmd:true req:FR002,FR001 -->',
      ].join('\n'),
      timestamp: 1,
    })
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    expect(result.status).toBe(200)
    if ('error' in result.body) return
    expect(result.body.view.requirementBindings.map((binding) => binding.rawTarget)).toEqual([
      'FR002',
      'FR001',
    ])
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
    expect(html).toContain('data-section="requirement-bindings"')
    expect(html).toContain('<code>specs/x/spec.md#FR002</code> second intent')
    expect(html.indexOf('#FR002')).toBeLessThan(html.indexOf('#FR001'))
  })

  test('409 exposes only escaped dangling/ambiguous broken bindings', () => {
    indexClauseFile(db, { specPath: 'specs/x/a.md', content: '## FR001 <first>', timestamp: 1 })
    indexClauseFile(db, { specPath: 'specs/x/b.md', content: '## FR001 second', timestamp: 1 })
    indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content:
        '## C001 broken <!-- oracle:cmd:true req:FR001,specs/missing/spec.md#FR404 -->',
      timestamp: 1,
    })
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    expect(result.status).toBe(409)
    if (!('error' in result.body)) return
    expect(result.body.requirementBindings.map((binding) => binding.state)).toEqual([
      'ambiguous',
      'dangling',
    ])
    const html = renderBriefErrorPage(result.body.error, result.body.requirementBindings)
    expect(html).toContain('data-state="req-ambiguous"')
    expect(html).toContain('data-state="req-dangling"')
    expect(html).toContain('data-tone="danger"')
    expect(html).toContain('&lt;first&gt;')
    expect(html).not.toContain('data-state="req-resolved"')
    expect(html).not.toContain('id="review-form"')
  })
})

const snapshot = (uncovered: UiSnapshot['status']['uncoveredRequirements']): UiSnapshot => ({
  head: null,
  dirty: false,
  status: {
    schema: 'urtext.status/1',
    head: null,
    items: [],
    counts: { agent: 0, human: 0, uncovered: 999, autoPass: 0 },
    wip: { limit: 10, exceeded: false },
    uncoveredRequirements: uncovered,
  },
  clauses: [],
  decided: 0,
  totalManual: 0,
  unmapped: [],
  unmappedError: null,
})

describe('uncovered intent console projection', () => {
  test('uses array length, escapes content, stays outside pagination, and is queue-only', () => {
    const input = snapshot([
      { specPath: 'specs/x/spec.md', reqId: 'FR002', title: '<uncovered>' },
    ])
    input.status.items = ['C001', 'C002'].map((clauseId) => ({
      key: `specs/x/spec.md#${clauseId}`,
      kind: 'clause' as const,
      lane: 'human' as const,
      primary: 'manual_undecided' as const,
      reasons: ['manual_undecided' as const],
      next: 'decide',
      specPath: 'specs/x/spec.md',
      clauseId,
      title: clauseId,
      risk: 'low' as const,
    }))
    input.status.counts.human = 2
    const render = (route: 'queue' | 'agent' | 'specs' | 'decisions') =>
      renderConsoleFamilyPage({ route, snapshot: input, csrfToken: 'tok', page: 1, pageSize: 1 })
    const queue = render('queue')
    expect(queue).toContain('id="uncovered-intent"')
    expect(queue).toContain('Uncovered intent (1)')
    expect(queue).toContain('data-uncovered="specs/x/spec.md#FR002"')
    expect(queue).toContain('&lt;uncovered&gt;')
    expect(queue).not.toContain('Uncovered intent (999)')
    const tableIndex = queue.indexOf('<table>')
    const paginationIndex = queue.indexOf('<nav aria-label="分页">')
    const uncoveredIndex = queue.indexOf('id="uncovered-intent"')
    expect(tableIndex).toBeGreaterThanOrEqual(0)
    expect(paginationIndex).toBeGreaterThan(tableIndex)
    expect(uncoveredIndex).toBeGreaterThan(paginationIndex)
    for (const route of ['agent', 'specs', 'decisions'] as const) {
      expect(render(route)).not.toContain('id="uncovered-intent"')
    }
    const empty = renderConsoleFamilyPage({
      route: 'queue',
      snapshot: snapshot([]),
      csrfToken: 'tok',
      page: 1,
      pageSize: 1,
    })
    expect(empty).toContain('data-state="uncovered-none"')
  })
})
