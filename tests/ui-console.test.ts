import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { recordDecision } from '../src/decision.js'
import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot, type UiSnapshot } from '../src/review-ui.js'
import { scanWorkspace } from '../src/scanner.js'
import type { StatusItem } from '../src/status.js'
import { verifyWorkspace } from '../src/verifier.js'
import { renderConsoleFamilyPage, renderConsolePage, type ConsoleRoute } from '../src/ui/render-console.js'
import { CONSOLE_SCRIPT } from '../src/ui/console-script.js'
import { esc } from '../src/ui/html.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const setupRepo = (extraClauseLine?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-console-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  const lines = ['## FR001 test intent', '## C001 design intent <!-- oracle:manual req:FR001 -->', '## C002 label <!-- oracle:cmd:true req:FR001 -->']
  if (extraClauseLine) lines.push(extraClauseLine)
  writeFileSync(join(root, 'specs/x/spec.md'), lines.join('\n'))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  return root
}

const render = (
  route: ConsoleRoute,
  snapshot: UiSnapshot,
  page = 1,
  pageSize = 20,
  auditResult?: string
): string => renderConsoleFamilyPage({ route, snapshot, csrfToken: 'tok', page, pageSize, ...(auditResult !== undefined ? { auditResult } : {}) })

const mainListTableCount = (html: string): number => (html.match(/<table>/g) ?? []).length

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('console-family shell and route ownership', () => {
  test('all routes keep the shared landmark order and one h1', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    for (const route of ['queue', 'agent', 'specs', 'decisions'] as const) {
      const html = render(route, snapshot)
      const bodyStart = html.indexOf('<body>')
      const skipIdx = html.indexOf('<a class="skip" href="#main">')
      const headerIdx = html.indexOf('<header>')
      const navIdx = html.indexOf('<nav aria-label="页面导航">')
      const mainIdx = html.indexOf('<main id="main">')
      expect(bodyStart).toBeLessThan(skipIdx)
      expect(skipIdx).toBeLessThan(headerIdx)
      expect(headerIdx).toBeLessThan(navIdx)
      expect(navIdx).toBeLessThan(mainIdx)
      expect((html.match(/<h1[ >]/g) ?? [])).toHaveLength(1)
      expect(html).toContain('<html lang="zh-CN">')
    }
  })

  test('shared header renders short HEAD, dirty state, and no links', () => {
    const root = setupRepo()
    const snapshot = buildUiSnapshot(db, root)
    const clean = render('queue', snapshot)
    expect(clean).toContain(`<code>${snapshot.head!.slice(0, 7)}</code>`)
    expect(clean).not.toContain('worktree dirty')
    const header = clean.slice(clean.indexOf('<header>'), clean.indexOf('</header>'))
    expect(header).not.toContain('<a href')
    writeFileSync(join(root, 'specs/x/spec.md'), '## FR001 test intent\n## C001 design intent <!-- oracle:manual req:FR001 -->\nchanged\n')
    const dirty = render('queue', buildUiSnapshot(db, root))
    expect(dirty).toContain('⚠ worktree dirty')
    expect(dirty).toContain('data-tone="warn"')
  })

  test('all route navigations use fixed links, one current page, and canonical refresh', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const cases = [
      ['queue', ['/', '/agent', '/specs', '/decisions', '/']],
      ['agent', ['/', '/agent', '/specs', '/decisions', '/agent']],
      ['specs', ['/', '/agent', '/specs', '/decisions', '/specs']],
      ['decisions', ['/', '/agent', '/specs', '/decisions', '/decisions']],
    ] as const
    for (const [route, hrefs] of cases) {
      const html = render(route, snapshot)
      const start = html.indexOf('<nav aria-label="页面导航">')
      const nav = html.slice(start, html.indexOf('</nav>', start) + 6)
      expect([...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual(hrefs)
      expect((html.match(/aria-current="page"/g) ?? [])).toHaveLength(1)
    }
  })

  test('page-two refresh preserves the canonical page without audit parameters', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = render('specs', snapshot, 2, 1)
    const start = html.indexOf('<nav aria-label="页面导航">')
    const nav = html.slice(start, html.indexOf('</nav>', start) + 6)
    expect([...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      '/',
      '/agent',
      '/specs',
      '/decisions',
      '/specs?page=2',
    ])
    expect(nav).not.toContain('audit=')
  })

  test('each route owns exactly its specified main content', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const pages = {
      queue: render('queue', snapshot),
      agent: render('agent', snapshot),
      specs: render('specs', snapshot),
      decisions: render('decisions', snapshot),
    }
    expect(pages.queue).toContain('id="your-queue-title"')
    expect(pages.queue).toContain(`${snapshot.status.counts.human} for you`)
    expect(pages.queue).not.toContain('id="agent-lane-title"')
    expect(pages.queue).not.toContain('id="all-specs"')
    expect(pages.queue).not.toContain('id="decided-title"')
    expect(pages.queue).not.toContain('id="audit-runner"')
    expect(pages.queue).toContain('id="uncovered-intent"')
    expect(pages.queue).toContain(
      `${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided`
    )

    expect(pages.agent).toContain('id="agent-lane-title"')
    expect(pages.agent).toContain('id="audit-runner"')
    expect(pages.agent).not.toContain('id="your-queue-title"')
    expect(pages.agent).not.toContain('id="all-specs"')
    expect(pages.agent).not.toContain('id="decided-title"')
    expect(pages.agent).not.toContain(`${snapshot.status.counts.human} for you`)
    expect(pages.agent).not.toContain('data-banner="wip"')
    expect(pages.agent).not.toContain('urtext map &lt;spec&gt;')
    expect(pages.agent).not.toContain('id="uncovered-intent"')

    expect(pages.specs).toContain('id="all-specs"')
    expect(pages.specs).not.toContain('id="your-queue-title"')
    expect(pages.specs).not.toContain('id="agent-lane-title"')
    expect(pages.specs).not.toContain('id="decided-title"')
    expect(pages.specs).not.toContain('id="audit-runner"')
    expect(pages.specs).not.toContain('data-banner="wip"')
    expect(pages.specs).not.toContain('urtext map &lt;spec&gt;')
    expect(pages.specs).not.toContain('id="uncovered-intent"')

    expect(pages.decisions).toContain('id="decided-title"')
    expect(pages.decisions).not.toContain('id="your-queue-title"')
    expect(pages.decisions).not.toContain('id="agent-lane-title"')
    expect(pages.decisions).not.toContain('id="all-specs"')
    expect(pages.decisions).not.toContain('id="audit-runner"')
    expect(pages.decisions).not.toContain('data-banner="wip"')
    expect(pages.decisions).not.toContain('urtext map &lt;spec&gt;')
    expect(pages.decisions).not.toContain('id="uncovered-intent"')
  })

  test('only interactive routes carry CSRF and the console script', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    for (const route of ['queue', 'agent'] as const) {
      const html = render(route, snapshot)
      expect(html).toContain('<meta name="csrf-token" content="tok">')
      expect(html).toContain(CONSOLE_SCRIPT)
    }
    for (const route of ['specs', 'decisions'] as const) {
      const html = render(route, snapshot)
      expect(html).not.toContain('name="csrf-token"')
      expect(html).not.toContain('<script>')
    }
  })

  test('every aria-labelledby target exists exactly once and every table has a caption and column headers', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    for (const route of ['queue', 'agent', 'specs', 'decisions'] as const) {
      const html = render(route, snapshot)
      for (const id of [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1])) {
        expect((html.match(new RegExp(`id="${id}"`, 'g')) ?? [])).toHaveLength(1)
      }
      for (const table of [...html.matchAll(/<table>[\s\S]*?<\/table>/g)].map((match) => match[0])) {
        expect(table).toContain('<caption>')
        expect(table).toContain('<th scope="col">')
      }
      expect(mainListTableCount(html)).toBe(1)
      expect(html).not.toContain('<nav aria-label="分页">')
    }
  })

  test('single-page table captions report full route totals', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    expect(render('queue', snapshot)).toContain('<caption>Your queue (共 1 条 · 第 1/1 页)</caption>')
    expect(render('agent', snapshot)).toContain('<caption>Agent lane (共 1 条 · 第 1/1 页)</caption>')
    expect(render('specs', snapshot)).toContain('<caption>All Specs (共 2 条 · 第 1/1 页)</caption>')
    expect(render('decisions', snapshot)).toContain('<caption>Decided manual clauses at HEAD (共 0 条 · 第 1/1 页)</caption>')
  })
})

describe('queue projection and unmapped remediation', () => {
  test('queue rows paginate without reordering and include stable data-row keys', () => {
    const snapshot = buildUiSnapshot(db, setupRepo('## C003 another manual <!-- oracle:manual req:FR001 -->'))
    const human = snapshot.status.items.filter((item) => item.lane === 'human')
    expect(human.length).toBeGreaterThanOrEqual(2)
    const first = render('queue', snapshot, 1, 1)
    const second = render('queue', snapshot, 2, 1)
    expect(first).toContain(`data-row="${human[0]!.key}"`)
    expect(first).not.toContain(`data-row="${human[1]!.key}"`)
    expect(second).toContain(`data-row="${human[1]!.key}"`)
    expect(first).toContain('第 1 / 共')
    expect(second).toContain('rel="prev" href="/"')
  })

  test('decision form ids are page-local and labels stay paired with textareas', () => {
    const snapshot = buildUiSnapshot(db, setupRepo('## C003 another manual <!-- oracle:manual req:FR001 -->'))
    for (const page of [render('queue', snapshot, 1, 1), render('queue', snapshot, 2, 1)]) {
      expect((page.match(/id="decision-form-0"/g) ?? [])).toHaveLength(1)
      expect(page).toContain('<label for="decision-note-0">Reason</label>')
      expect(page).toContain('<textarea id="decision-note-0" name="note">')
      const start = page.indexOf('<nav aria-label="分页">')
      const pagination = page.slice(start, page.indexOf('</nav>', start) + 6)
      expect(pagination).toContain('第 ')
      expect(pagination).toContain('aria-disabled="true"')
    }
  })

  test('queue preserves inline decide behavior, empty text, WIP copy, and escaping', () => {
    const root = setupRepo(`## C003 <script>'"&x <!-- oracle:manual req:FR001 -->`)
    const snapshot = buildUiSnapshot(db, root)
    const html = render('queue', snapshot)
    expect(html).toContain('data-key="specs/x/spec.md#C001"')
    expect(html).toContain('class="decide-form"')
    expect(html).toContain('data-v="pass"')
    expect(html).toContain('data-v="fail"')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>\'"&x')
    snapshot.status.wip = { limit: 1, exceeded: true }
    snapshot.status.counts.human = 5
    const wip = render('queue', snapshot)
    expect(wip).toContain('data-banner="wip"')
    expect(wip).toContain('warning: human queue 5 exceeds wip limit 1 — consider smaller changes')
    const empty = render('queue', { ...snapshot, status: { ...snapshot.status, items: [] } })
    expect(empty).toContain('nothing — prerequisites pending or all clear')
  })

  test('a decided clause no longer renders its decide form', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    expect(render('queue', buildUiSnapshot(db, root))).not.toContain('data-key="specs/x/spec.md#C001"')
  })

  test('clean snapshots render neither unmapped banner state on any route', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    for (const route of ['queue', 'agent', 'specs', 'decisions'] as const) {
      const html = render(route, { ...snapshot, unmapped: [], unmappedError: null })
      expect(html).not.toContain('data-banner="unmapped">')
      expect(html).not.toContain('data-banner="unmapped-error"')
    }
  })

  test('compact alert appears once while remediation commands exist only in paginated unmapped rows', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const unmapped: StatusItem[] = Array.from({ length: 100 }, (_, index) => ({
      key: index === 0 ? '<bad>.ts:1-1' : `src/file.ts:${index + 1}-${index + 1}`,
      kind: 'unmapped',
      lane: 'human',
      primary: 'unmapped',
      reasons: ['unmapped'],
      next: '`urtext map <spec>#<clause> <range>` | `urtext ack <range> <reason>` | write back to spec',
      filePath: index === 0 ? '<bad>.ts' : 'src/file.ts',
      lineStart: index + 1,
      lineEnd: index + 1,
    }))
    const input = {
      ...snapshot,
      unmapped: unmapped.map((item) => ({ filePath: item.filePath!, lineStart: item.lineStart!, lineEnd: item.lineEnd! })),
      status: { ...snapshot.status, items: unmapped, counts: { ...snapshot.status.counts, human: 100 } },
    }
    const html = render('queue', input, 1, 2)
    expect((html.match(/data-banner="unmapped">/g) ?? [])).toHaveLength(1)
    expect(html).toContain('⚠ 100 个未归属变更（工作区级，git diff HEAD，未跟踪文件不在检测范围）— 详见下方 Your queue 行')
    expect((html.match(/urtext map/g) ?? [])).toHaveLength(2)
    expect((html.match(/urtext ack/g) ?? [])).toHaveLength(2)
    expect(html).not.toContain('workspace-alert-title')
    expect(html).toContain('映射：<code>urtext map &lt;spec&gt;#&lt;clause&gt; &lt;bad&gt;.ts:1-1</code>')
    expect(html).toContain('确认例外：<code>urtext ack &lt;bad&gt;.ts:1-1 &lt;reason&gt;</code>')
    expect(html).toContain('<br>或先修改对应 spec，再刷新状态。</small>')
    expect(html).not.toContain('data-banner="unmapped-error"')
  })

  test('non-queue routes link compact unmapped states back to Your queue', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const hunks = render('specs', { ...snapshot, unmapped: [{ filePath: 'bad.ts', lineStart: 2, lineEnd: 3 }], unmappedError: null })
    expect(hunks).toContain('data-banner="unmapped">')
    expect(hunks).toContain('<a href="/">在 Your queue 处理</a>')
    expect(hunks).not.toContain('urtext map')
    expect(hunks).not.toContain('data-banner="unmapped-error"')
    const failed = render('decisions', { ...snapshot, unmapped: [], unmappedError: '<git failed>' })
    expect(failed).toContain('data-banner="unmapped-error"')
    expect(failed).toContain('&lt;git failed&gt;')
    expect(failed).toContain('<a href="/">在 Your queue 查看</a>')
    expect(failed).not.toContain('data-banner="unmapped">')
  })
})

describe('agent projection and audit controls', () => {
  test('audit runner is enabled for auditable items and keeps transport behavior', () => {
    const html = render('agent', buildUiSnapshot(db, setupRepo()), 1, 20, 'imported 3 verdict(s)')
    expect(html).toContain('id="audit-runner"')
    expect(html).toContain('value="claude"')
    expect(html).toContain('value="codex"')
    expect(html).toContain('<option value="traex">Traex</option>')
    expect(html).toContain('value="omp"')
    expect(html).toContain('id="audit-progress"')
    expect(html).toContain('id="audit-result"')
    expect(html).toContain('imported 3 verdict(s)')
    expect(html).toContain('/api/audit-run')
    expect(html).toContain('button.disabled = true')
    expect(html).not.toContain('<button type="submit" disabled>Run audit</button>')
    expect(html.match(/href="[^"]*audit=[^"]*"/g)).toBeNull()
  })

  test('zero auditable items keep a disabled runner and explicit empty state', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = render('agent', { ...snapshot, status: { ...snapshot.status, items: [] } })
    expect(html).toContain('Audit 0 evidence item(s)')
    expect(html).toContain('<button type="submit" disabled>Run audit</button>')
    expect(html).toContain('当前没有待审计的证据')
  })

  test('next hints are deduplicated from only the current agent page', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const template = snapshot.status.items.find((item) => item.lane === 'agent')
    expect(template).toBeDefined()
    const items = [template!, { ...template!, key: `${template!.key}-same` }, { ...template!, key: `${template!.key}-other`, next: 'other hint' }]
    const html = render('agent', { ...snapshot, status: { ...snapshot.status, items } }, 1, 2)
    expect(html.split(esc(template!.next)).length - 1).toBe(1)
    expect(html).toContain('Audit 3 evidence item(s)')
    expect(html).not.toContain('other hint')
    expect(html).not.toContain('data-section="agent-lane"')
    expect(html).toContain('<h2 id="agent-lane-title">')
    expect(html).not.toContain('<details')
  })
})

describe('spec and decision projections', () => {
  test('All Specs uses one table with adjacent spec rowgroups and per-page counts', () => {
    const snapshot = buildUiSnapshot(db, setupRepo('## C003 third <!-- oracle:manual req:FR001 -->'))
    const clauses = [snapshot.clauses[0]!, { ...snapshot.clauses[1]!, specPath: 'specs/y/spec.md' }, { ...snapshot.clauses[2]!, specPath: 'specs/y/spec.md' }]
    const html = render('specs', { ...snapshot, clauses }, 1, 20)
    expect(mainListTableCount(html)).toBe(1)
    expect(html).toContain('<tbody data-spec="specs/x/spec.md">')
    expect(html).toContain('<tbody data-spec="specs/y/spec.md">')
    expect(html).toContain('<th colspan="3" scope="rowgroup"><code>specs/x/spec.md</code> (本页 1)</th>')
    expect(html).toContain('<th colspan="3" scope="rowgroup"><code>specs/y/spec.md</code> (本页 2)</th>')
    expect(html).not.toContain('spec-group-')
    expect(html).not.toContain('<h3')
    expect(html).toMatch(/data-state="(fresh|no-evidence)"/)
  })

  test('All Specs pagination preserves data-clause order and page-local group counts', () => {
    const snapshot = buildUiSnapshot(db, setupRepo('## C003 third <!-- oracle:manual req:FR001 -->'))
    const html = render('specs', snapshot, 2, 1)
    expect(html).toContain(`data-clause="${snapshot.clauses[1]!.specPath}#${snapshot.clauses[1]!.clauseId}"`)
    expect(html).not.toContain(`data-clause="${snapshot.clauses[0]!.specPath}#${snapshot.clauses[0]!.clauseId}"`)
    expect(html).toContain('(本页 1)')
    expect(html).toContain('<caption>All Specs (共 3 条 · 第 2/3 页)</caption>')
    expect(html).toContain('<nav aria-label="分页">')
  })

  test('empty All Specs has no table or pagination navigation', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = render('specs', { ...snapshot, clauses: [] })
    expect(html).toContain('<h2 id="all-specs-title">All Specs (0)</h2><p>no live clauses</p>')
    expect(mainListTableCount(html)).toBe(0)
    expect(html).not.toContain('<nav aria-label="分页">')
  })

  test('decisions route filters and paginates decided clauses in snapshot order', () => {
    const root = setupRepo('## C003 another manual <!-- oracle:manual req:FR001 -->')
    const empty = render('decisions', buildUiSnapshot(db, root))
    expect(empty).toContain('none yet')
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C003', verdict: 'fail', decider: 'alice' }, root, 2)
    const snapshot = buildUiSnapshot(db, root)
    const first = render('decisions', snapshot, 1, 1)
    const second = render('decisions', snapshot, 2, 1)
    expect(first).toContain('data-row="specs/x/spec.md#C001"')
    expect(first).toContain('✓ pass')
    expect(first).toContain('data-tone="ok"')
    expect(first).not.toContain('data-row="specs/x/spec.md#C003"')
    expect(second).toContain('data-row="specs/x/spec.md#C003"')
    expect(second).toContain('✗ fail')
    expect(second).not.toContain('data-row="specs/x/spec.md#C001"')
  })
})

describe('C028 human-projection rendering', () => {
  const staleItem = (source?: string): StatusItem => ({
    key: 'specs/x/spec.md#C002',
    kind: 'clause',
    lane: 'agent',
    primary: 'stale',
    reasons: ['stale'],
    next: 're-run verify',
    specPath: 'specs/x/spec.md',
    clauseId: 'C002',
    title: 'dependent',
    risk: 'low',
    ...(source === undefined ? {} : { invalidationSource: source }),
  })

  test('renders sourced and legacy causal chains on the agent lane', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = render('agent', {
      ...snapshot,
      status: {
        ...snapshot.status,
        items: [staleItem('specs/x/spec.md#C001'), staleItem()],
        counts: { ...snapshot.status.counts, agent: 2 },
      },
    })
    expect(html).toContain('specs/x/spec.md#C001</code> 文本变更 → <code>specs/x/spec.md#C002</code> 证据作废')
    expect(html).toContain('上游变更 → <code>specs/x/spec.md#C002</code> 证据作废')
  })

  test('renders one DOM feature-health target after alerts and excludes stale evidence from health denominators', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = render('queue', {
      ...snapshot,
      dirty: true,
      unmapped: [{ filePath: 'src/unmapped.ts', lineStart: 1, lineEnd: 1 }],
      status: {
        ...snapshot.status,
        items: [
          {
            key: 'src/unmapped.ts:1-1',
            kind: 'unmapped',
            lane: 'human',
            primary: 'unmapped',
            reasons: ['unmapped'],
            next: 'map it',
            filePath: 'src/unmapped.ts',
            lineStart: 1,
            lineEnd: 1,
          },
        ],
        counts: { ...snapshot.status.counts, human: 1 },
      },
      clauses: [
        {
          specPath: 'specs/x/spec.md',
          clauseId: 'C001',
          title: 'stale pass',
          risk: 'high',
          decisionVerdict: 'n/a',
          evidenceVerdict: 'pass',
          auditVerdict: 'agree',
          reviewStatus: 'approved',
          stale: true,
          actionable: false,
        },
      ],
    })
    expect((html.match(/<table>/g) ?? [])).toHaveLength(1)
    expect(html.indexOf('data-banner="unmapped"')).toBeLessThan(html.indexOf('id="feature-health"'))
    expect(html.indexOf('id="feature-health"')).toBeLessThan(html.indexOf('id="your-queue-rows"'))
    expect((html.match(/\bid="feature-health"/g) ?? [])).toHaveLength(1)
    expect(html).toContain('<section id="feature-health-section"')
    expect(html).toContain('证据 <span data-tone="muted" data-state="health-unavailable">— n/a (0/0)</span>')
    expect(html).toContain('元审计 <span data-tone="muted" data-state="health-unavailable">— n/a (0/0)</span>')
    expect(html).toContain('高危已批准 <span data-tone="warn" data-state="health-incomplete">⚠ 0/1</span>')
  })

  test('gives every human row a distinct explain button/output pair and keeps agent rows control-free', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const humanRows: StatusItem[] = [
      {
        key: 'src/unmapped.ts:1-1', kind: 'unmapped', lane: 'human', primary: 'unmapped', reasons: ['unmapped'], next: 'map it', filePath: 'src/unmapped.ts', lineStart: 1, lineEnd: 1,
      },
      {
        key: 'specs/x/spec.md#C001', kind: 'clause', lane: 'human', primary: 'manual_undecided', reasons: ['manual_undecided'], next: 'decide', specPath: 'specs/x/spec.md', clauseId: 'C001', title: 'manual', risk: 'low',
      },
    ]
    const queue = render('queue', { ...snapshot, status: { ...snapshot.status, items: humanRows, counts: { ...snapshot.status.counts, human: 2 } } })
    const agent = render('agent', { ...snapshot, status: { ...snapshot.status, items: [staleItem()], counts: { ...snapshot.status.counts, agent: 1 } } })
    expect(queue).toContain('id="explain-item-btn-0" aria-controls="explain-item-out-0"')
    expect(queue).toContain('id="explain-item-btn-1" aria-controls="explain-item-out-1"')
    expect(queue).toContain('id="queue-explain-btn" aria-controls="queue-explain-out"')
    expect(agent).not.toContain('data-explain-key=')
  })
})

describe('public renderConsolePage wrapper', () => {
  test('keeps positional parameters, queue route defaults, and auditResult passthrough', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    const html = renderConsolePage(snapshot, 'my-token', '<imported>')
    expect(html).toContain('id="your-queue-title"')
    expect(html).toContain('<meta name="csrf-token" content="my-token">')
    expect(html).toContain('id="audit-result"')
    expect(html).toContain('&lt;imported&gt;')
    expect(html).not.toContain('id="agent-lane-title"')
  })

  test('omitting auditResult keeps the queue page free of the result notice', () => {
    const snapshot = buildUiSnapshot(db, setupRepo())
    expect(renderConsolePage(snapshot, 'tok')).not.toContain('id="audit-result"')
  })

  test('keeps script hygiene and sends audit success to the agent route', () => {
    expect(CONSOLE_SCRIPT).not.toMatch(/\bprompt\(/)
    expect(CONSOLE_SCRIPT).not.toMatch(/\balert\(/)
    expect(CONSOLE_SCRIPT).not.toMatch(/\son\w+\s*=/)
    expect(CONSOLE_SCRIPT).toContain("location.href = '/agent?audit='")
    expect(CONSOLE_SCRIPT).not.toContain("location.href = '/?audit='")
  })
})
