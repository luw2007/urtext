import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ensureAuditLedger } from '../src/audit.js'
import type { AsyncSpawn } from '../src/audit-runner.js'
import { run } from '../src/cli.js'
import { ensureDecisionLedger } from '../src/decision.js'
import { ensureCodeMap } from '../src/dwarf.js'
import { propagateStale } from '../src/linker.js'
import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot, handleBrief, handleExplain, type UiSnapshot } from '../src/review-ui.js'
import { ensureReviewLedger } from '../src/review.js'
import { scanWorkspace } from '../src/scanner.js'
import { ensureEvidenceLedger, verifyWorkspace } from '../src/verifier.js'
import { parseClauseFile } from '../src/clause-parser.js'
import { renderBriefPage } from '../src/ui/render-brief.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { renderConsoleFamilyPage } from '../src/ui/render-console.js'
import { parseTaskFile } from '../src/task-parser.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tempDirs: string[] = []
const databases: Database[] = []

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

interface WorkspaceFixture {
  root: string
  db: Database
}

const createWorkspace = (
  spec: string,
  files: Record<string, string> = {}
): WorkspaceFixture => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-c028-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), '.urtext/\n')
  writeFileSync(join(root, 'specs/x/spec.md'), spec)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')

  const registryDir = join(root, '.urtext')
  mkdirSync(registryDir, { recursive: true })
  const db = new DatabaseConstructor(join(registryDir, 'registry.sqlite'))
  databases.push(db)
  db.pragma('journal_mode = WAL')
  openRegistry(db)
  scanWorkspace(db, root)
  return { root, db }
}

const renderConsole = (snapshot: UiSnapshot, route: 'queue' | 'agent' = 'queue'): string =>
  renderConsoleFamilyPage({ route, snapshot, csrfToken: 'csrf', page: 1, pageSize: 100 })

const successfulBrief = (db: Database, root: string, clauseId: string) => {
  const result = handleBrief(db, root, 'specs/x/spec.md', clauseId)
  if (result.status !== 200 || !('ok' in result.body)) throw new Error(`expected successful brief for ${clauseId}`)
  return result.body
}

const renderBrief = (db: Database, root: string, clauseId: string): string => {
  const brief = successfulBrief(db, root, clauseId)
  return renderBriefPage({
    text: brief.text,
    csrfToken: 'csrf',
    key: `specs/x/spec.md#${clauseId}`,
    briefHash: brief.briefHash,
    reviewable: brief.reviewable,
    facts: brief.facts,
    view: brief.view,
    config: DEFAULT_UI_RENDER_CONFIG,
  })
}

const fragment = (html: string, opener: string, closer: string): string => {
  const start = html.indexOf(opener)
  const end = start < 0 ? -1 : html.indexOf(closer, start)
  if (start < 0 || end < 0) throw new Error(`missing fragment ${opener}`)
  return html.slice(start, end + closer.length)
}

type LedgerSnapshot = Record<string, unknown[]>

const ledgerSnapshot = (db: Database): LedgerSnapshot => {
  ensureEvidenceLedger(db)
  ensureAuditLedger(db)
  ensureDecisionLedger(db)
  ensureReviewLedger(db)
  ensureCodeMap(db)
  return Object.fromEntries(
    ['evidence', 'audit_verdicts', 'decisions', 'reviews', 'clause_code_map'].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ])
  )
}

const fakeExplainSpawn = (prompts: string[], response: string): AsyncSpawn =>
  ((..._args: unknown[]) => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    Object.assign(child, {
      stdout,
      stdin: {
        end: (prompt: string) => {
          prompts.push(prompt)
          queueMicrotask(() => {
            stdout.emit('data', Buffer.from(response))
            child.emit('close', 0)
          })
        },
      },
      kill: () => {},
    })
    return child
  }) as AsyncSpawn

const failingExplainSpawn = (prompts: string[], message: string): AsyncSpawn =>
  ((..._args: unknown[]) => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    Object.assign(child, {
      stdout,
      stdin: {
        end: (prompt: string) => {
          prompts.push(prompt)
          queueMicrotask(() => child.emit('error', new Error(message)))
        },
      },
      kill: () => {},
    })
    return child
  }) as AsyncSpawn

const expectMeaningfulLedgerSnapshot = (
  snapshot: LedgerSnapshot,
  clauseId = 'C001'
): void => {
  expect(snapshot.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        spec_path: 'specs/x/spec.md',
        clause_id: clauseId,
        oracle_kind: 'manual',
        verdict: 'pending',
      }),
    ])
  )
}

const runStatus = (root: string): { exit: number; output: string } => {
  const previous = process.cwd()
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)))
  try {
    process.chdir(root)
    return { exit: run(['status', '--json']), output: lines.join('\n') }
  } finally {
    process.chdir(previous)
    log.mockRestore()
  }
}


afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const root of tempDirs.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('C028 dedicated high-risk UI projection oracle', () => {
  test('C028 remains a dedicated high-risk test oracle with the T019 human-gated binding', () => {
    const clauses = parseClauseFile(readFileSync(join(ROOT, 'specs/urtext/spec.md'), 'utf8'))
    const c028 = clauses.clauses.find((clause) => clause.clauseId === 'C028')
    expect(c028).toMatchObject({
      oracle: { kind: 'test', ref: 'tests/ui-projection.test.ts' },
      risk: 'high',
      refs: [
        { path: 'specs/urtext/spec.md', clauseId: 'C008' },
        { path: 'specs/urtext/spec.md', clauseId: 'C016' },
        { path: 'specs/urtext/spec.md', clauseId: 'C019' },
        { path: 'specs/urtext/spec.md', clauseId: 'C026' },
      ],
      reqs: [{ path: null, reqId: 'FR009' }, { path: null, reqId: 'FR012' }],
    })

    const tasks = parseTaskFile(readFileSync(join(ROOT, 'specs/urtext/tasks.md'), 'utf8'))
    expect(tasks.errors).toEqual([])
    expect(tasks.tasks.find((task) => task.fileId === 'T019')).toMatchObject({
      dependsOn: ['T018'],
      clauses: ['C028'],
      humanGate: true,
    })
  })

  test('C028 P1 renders FR, legacy-NULL, and clause-key stale causality with the complete no-verify-pass-through copy', () => {
    const { db, root } = createWorkspace(
      [
        '## FR001 direct defender intent',
        '## FR002 independent intent',
        '## C001 direct defender <!-- oracle:cmd:true req:FR001 -->',
        '## C002 downstream dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR002 -->',
        '## C003 historical legacy row <!-- oracle:cmd:true req:FR002 -->',
      ].join('\n')
    )
    verifyWorkspace(db, root)
    expect(
      propagateStale(db, [], 99, [{ specPath: 'specs/x/spec.md', reqId: 'FR001' }])
    ).toMatchObject({ invalidatedEvidence: 2 })
    db.prepare('UPDATE evidence SET invalidated_at = 7 WHERE clause_id = ?').run('C003')

    const sourced = buildUiSnapshot(db, root)
    const sourcedHtml = renderConsole(sourced, 'agent')
    const frSource = 'specs/x/spec.md#FR001'
    expect(sourced.status.items.find((item) => item.key === 'specs/x/spec.md#C001')).toMatchObject({
      lane: 'agent',
      invalidationSource: frSource,
    })
    expect(sourced.status.items.find((item) => item.key === 'specs/x/spec.md#C003')).not.toHaveProperty(
      'invalidationSource'
    )
    expect(sourcedHtml).toContain(
      `${frSource}</code> 文本变更 → <code>specs/x/spec.md#C001</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行`
    )
    expect(sourcedHtml).toContain(
      '上游变更 → <code>specs/x/spec.md#C003</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行'
    )
    expect(runStatus(root).exit).toBe(1)

    const before = JSON.parse(JSON.stringify(sourced.status)) as UiSnapshot['status']
    db.prepare('UPDATE evidence SET invalidation_source = NULL WHERE invalidated_at = 99').run()
    const legacyOnly = buildUiSnapshot(db, root)
    const expectedStatus = JSON.parse(JSON.stringify(before)) as UiSnapshot['status']
    for (const item of expectedStatus.items) delete item.invalidationSource
    expect(legacyOnly.status).toEqual(expectedStatus)
    expect(runStatus(root).exit).toBe(1)
    db.prepare('UPDATE evidence SET invalidated_at = NULL, invalidation_source = NULL').run()
    expect(
      propagateStale(db, [{ specPath: 'specs/x/spec.md', clauseId: 'C001' }], 100)
    ).toMatchObject({ invalidatedEvidence: 1 })
    const clauseSourced = buildUiSnapshot(db, root)
    const clauseSource = 'specs/x/spec.md#C001'
    expect(clauseSourced.status.items.find((item) => item.key === 'specs/x/spec.md#C002')).toMatchObject({
      invalidationSource: clauseSource,
    })
    expect(renderConsole(clauseSourced, 'agent')).toContain(
      `<code>${clauseSource}</code> 文本变更 → <code>specs/x/spec.md#C002</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行`
    )
  })
  test('C028 P2 positions feature health after alerts, denies stale and dirty false-green completion, and leaves uncovered intent outside the queue', () => {
    const base: UiSnapshot = {
      head: 'abcdef0123456789',
      dirty: false,
      status: {
        schema: 'urtext.status/1',
        head: 'abcdef0123456789',
        items: [],
        counts: { agent: 0, human: 0, uncovered: 0, autoPass: 1 },
        wip: { limit: 10, exceeded: false },
        uncoveredRequirements: [{ specPath: 'specs/x/spec.md', reqId: 'FR099', title: 'uncovered intent' }],
      },
      clauses: [
        {
          specPath: 'specs/x/spec.md',
          clauseId: 'C001',
          title: 'high risk projection',
          risk: 'high',
          decisionVerdict: 'n/a',
          evidenceVerdict: 'pass',
          auditVerdict: 'agree',
          reviewStatus: 'approved',
          stale: true,
          actionable: false,
        },
      ],
      decided: 0,
      totalManual: 0,
      unmapped: [{ filePath: 'src/unmapped.ts', lineStart: 1, lineEnd: 1 }],
      unmappedError: null,
    }

    const staleHtml = renderConsole(base)
    const staleHealth = fragment(staleHtml, '<section id="feature-health-section"', '</section>')
    expect(staleHtml.indexOf('data-banner="unmapped"')).toBeLessThan(staleHtml.indexOf('id="feature-health"'))
    expect(staleHtml.indexOf('id="feature-health"')).toBeLessThan(staleHtml.indexOf('id="your-queue-rows"'))
    expect(staleHealth).toContain('<li data-feature="x"><a href="/specs">x</a>')
    expect(staleHealth).toContain('证据 <span data-tone="muted" data-state="health-unavailable">— n/a (0/0)</span>')
    expect(staleHealth).toContain('元审计 <span data-tone="muted" data-state="health-unavailable">— n/a (0/0)</span>')
    expect(staleHealth).toContain('高危已批准 <span data-tone="warn" data-state="health-incomplete">⚠ 0/1</span>')
    expect(staleHealth).toContain('未覆盖意图 <span data-tone="warn" data-state="health-uncovered">⚠ 1</span>')
    expect(staleHtml).toContain('只读投影：不进入队列、WIP 或退出码。')

    const dirtyHtml = renderConsole({
      ...base,
      dirty: true,
      clauses: [{ ...base.clauses[0]!, stale: false }],
    })
    const dirtyHealth = fragment(dirtyHtml, '<section id="feature-health-section"', '</section>')
    expect(dirtyHealth).toContain('证据 <span data-tone="ok" data-state="health-complete">✓ 1/1</span>')
    expect(dirtyHealth).toContain('元审计 <span data-tone="ok" data-state="health-complete">✓ 1/1</span>')
    expect(dirtyHealth).toContain('高危已批准 <span data-tone="warn" data-state="health-incomplete">⚠ 0/1</span>')

    const { db, root } = createWorkspace('## FR001 uncovered intent')
    const before = buildUiSnapshot(db, root).status
    const queue = renderConsole({ ...buildUiSnapshot(db, root), dirty: true })
    const after = buildUiSnapshot(db, root).status
    expect(after).toEqual(before)
    expect(queue).toContain('data-uncovered="specs/x/spec.md#FR001"')
    const status = runStatus(root)
    const statusJson = JSON.parse(status.output) as UiSnapshot['status']
    expect(status.exit).toBe(0)
    expect(statusJson.items).toEqual([])
    expect(statusJson.counts).toMatchObject({ human: 0, agent: 0, autoPass: 0 })
    expect(statusJson.wip).toEqual({ limit: 10, exceeded: false })
    expect(statusJson.uncoveredRequirements).toEqual([
      { specPath: 'specs/x/spec.md', reqId: 'FR001', title: 'uncovered intent' },
    ])
  })

  test('C028 P3 renders resolved FR, self, refs, and only direct dependents in a 390px-safe one-hop neighbourhood', () => {
    const { db, root } = createWorkspace(
      [
        '## FR001 defended intent',
        '## FR002 supporting intent',
        '## C004 referenced helper <!-- oracle:cmd:true req:FR002 -->',
        '## C001 target <!-- oracle:cmd:true refs:specs/x/spec.md#C004 req:FR001 -->',
        '## C002 direct dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR002 -->',
        '## C003 transitive-only dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C002 req:FR002 -->',
      ].join('\n')
    )
    const html = renderBrief(db, root, 'C001')
    const neighborhood = fragment(html, '<section data-section="neighborhood"', '</section>')

    expect(neighborhood).toContain('specs/x/spec.md#FR001')
    expect(neighborhood).toContain('specs/x/spec.md#C001')
    expect(neighborhood).toContain('specs/x/spec.md#C004')
    expect(neighborhood).toContain('specs/x/spec.md#C002')
    expect(neighborhood).not.toContain('specs/x/spec.md#C003')
    expect(html).toContain('[data-neighborhood]{display:flex;flex-wrap:wrap')
    expect(html).toContain('[data-neighbor]{flex:1 1 14rem')
    expect(html).toContain('overflow-wrap:anywhere')
  })

  test('C028 P4 gives every current human clause and unmapped item an explain control, keeps agent rows control-free, and generalizes successful details', () => {
    const { db, root } = createWorkspace(
      [
        '## FR001 intent',
        '## C001 first human <!-- oracle:manual req:FR001 -->',
        '## C002 agent prerequisite <!-- oracle:cmd:true req:FR001 -->',
        '## C003 second human <!-- oracle:manual req:FR001 -->',
      ].join('\n'),
      { 'src/impl.ts': 'export const current = 1\n' }
    )
    verifyWorkspace(db, root)
    writeFileSync(join(root, 'src/impl.ts'), 'export const current = 2\n')
    const snapshot = buildUiSnapshot(db, root)
    const queue = renderConsole(snapshot)
    const agent = renderConsole(snapshot, 'agent')
    const humanItems = snapshot.status.items.filter((item) => item.lane === 'human')

    expect(humanItems.map((item) => item.key)).toEqual([
      'src/impl.ts:1-1',
      'specs/x/spec.md#C001',
      'specs/x/spec.md#C003',
    ])
    humanItems.forEach((item, index) => {
      const control = fragment(queue, `id="explain-item-btn-${index}"`, `id="explain-item-out-${index}" aria-live="polite"></output>`)
      expect(control).toContain(`aria-controls="explain-item-out-${index}"`)
      expect(control).toContain(`data-explain-key="${item.key}"`)
    })
    expect(agent).not.toContain('data-explain-key=')

    for (const clauseId of ['C001', 'C002', 'C003']) {
      const detail = renderBrief(db, root, clauseId)
      const explain = fragment(detail, '<section id="explain"', '</section>')
      expect(explain).toContain(`data-explain-key="specs/x/spec.md#${clauseId}"`)
      expect(explain).toContain('id="explain-btn"')
      expect(explain).toContain('id="explain-out" aria-live="polite"')
    }
  })

  test('C028 P4 rejects a current agent-lane clause key with the exact 409 guard before transport', async () => {
    const { db, root } = createWorkspace('## FR001 intent\n## C001 agent prerequisite <!-- oracle:cmd:true req:FR001 -->')
    verifyWorkspace(db, root)
    expect(buildUiSnapshot(db, root).status.items.find((item) => item.key === 'specs/x/spec.md#C001')).toMatchObject({
      lane: 'agent',
      primary: 'unaudited',
    })
    const prompts: string[] = []
    const before = ledgerSnapshot(db)
    expect(before.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clause_id: 'C001', oracle_kind: 'cmd', verdict: 'pass' }),
      ])
    )

    await expect(
      handleExplain(db, root, { key: 'specs/x/spec.md#C001', auditor: 'claude' }, { spawnAsync: fakeExplainSpawn(prompts, 'must not run') })
    ).resolves.toEqual({ status: 409, body: { error: 'item is not in the current human queue' } })
    expect(prompts).toEqual([])
    expect(ledgerSnapshot(db)).toEqual(before)
  })

  test('C028 P4 reaches the ready human-lane buildBrief dangling-ref refusal without a fake explanation', async () => {
    const { db, root } = createWorkspace(
      '## FR001 intent\n## C001 dangling <!-- oracle:manual refs:specs/x/spec.md#C999 req:FR001 -->'
    )
    verifyWorkspace(db, root)
    expect(
      db.prepare('SELECT status FROM revisions WHERE spec_path = ? ORDER BY revision DESC LIMIT 1').get('specs/x/spec.md')
    ).toEqual({ status: 'ready' })
    expect(buildUiSnapshot(db, root).status.items.find((item) => item.key === 'specs/x/spec.md#C001')).toMatchObject({
      lane: 'human',
      primary: 'manual_undecided',
    })
    const prompts: string[] = []
    const before = ledgerSnapshot(db)
    expectMeaningfulLedgerSnapshot(before)

    await expect(
      handleExplain(db, root, { key: 'specs/x/spec.md#C001', auditor: 'claude' }, { spawnAsync: fakeExplainSpawn(prompts, 'must not run') })
    ).resolves.toEqual({
      status: 409,
      body: {
        error: 'specs/x/spec.md has 1 unresolved link error(s) (unknown_ref) — fix the reported refs/reqs before adjudicating.',
      },
    })
    expect(prompts).toEqual([])
    expect(ledgerSnapshot(db)).toEqual(before)
  })

  test('C028 P4/R4 accepts one current human clause-key explanation and keeps meaningful ledgers byte-identical', async () => {
    const { db, root } = createWorkspace('## FR001 intent\n## C001 human queue item <!-- oracle:manual req:FR001 -->')
    verifyWorkspace(db, root)
    expect(buildUiSnapshot(db, root).status.items.find((item) => item.key === 'specs/x/spec.md#C001')).toMatchObject({
      lane: 'human',
      primary: 'manual_undecided',
    })
    const prompts: string[] = []
    const ephemeral = 'C028 current human key explanation must not persist'
    const before = ledgerSnapshot(db)
    expectMeaningfulLedgerSnapshot(before)

    await expect(
      handleExplain(
        db,
        root,
        { key: 'specs/x/spec.md#C001', auditor: 'claude' },
        { spawnAsync: fakeExplainSpawn(prompts, ephemeral) }
      )
    ).resolves.toEqual({ status: 200, body: { ok: true, text: ephemeral } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('"source":"brief-manifest"')
    const after = ledgerSnapshot(db)
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).not.toContain(ephemeral)
  })

  test('C028 P4 rejects key XOR queue scope with the exact 400 body before transport', async () => {
    const { db, root } = createWorkspace('## FR001 intent\n## C001 human queue item <!-- oracle:manual req:FR001 -->')
    verifyWorkspace(db, root)
    const prompts: string[] = []
    const before = ledgerSnapshot(db)
    expectMeaningfulLedgerSnapshot(before)

    await expect(
      handleExplain(
        db,
        root,
        { key: 'specs/x/spec.md#C001', scope: 'queue', auditor: 'claude' },
        { spawnAsync: fakeExplainSpawn(prompts, 'must not run') }
      )
    ).resolves.toEqual({ status: 400, body: { error: 'provide exactly one of key or scope' } })
    expect(prompts).toEqual([])
    expect(ledgerSnapshot(db)).toEqual(before)
  })

  test('C028 P4/R4 fail-closes a current human clause transport error as 422 without a success body or ledger write', async () => {
    const { db, root } = createWorkspace('## FR001 intent\n## C001 human queue item <!-- oracle:manual req:FR001 -->')
    verifyWorkspace(db, root)
    const prompts: string[] = []
    const before = ledgerSnapshot(db)
    expectMeaningfulLedgerSnapshot(before)

    await expect(
      handleExplain(
        db,
        root,
        { key: 'specs/x/spec.md#C001', auditor: 'claude' },
        { spawnAsync: failingExplainSpawn(prompts, 'C028 explain transport unavailable') }
      )
    ).resolves.toEqual({ status: 422, body: { error: 'C028 explain transport unavailable' } })
    expect(prompts).toHaveLength(1)
    expect(ledgerSnapshot(db)).toEqual(before)
  })

  test('C028 P4/R4 makes a successful queue explanation response-only and leaves every ledger byte-for-byte unchanged', async () => {
    const { db, root } = createWorkspace(
      '## FR001 intent\n## C001 human queue item <!-- oracle:manual req:FR001 -->\n## C002 runner <!-- oracle:cmd:true req:FR001 -->'
    )
    verifyWorkspace(db, root)
    const prompts: string[] = []
    const ephemeral = 'C028 R4 ephemeral explanation must not persist'
    const before = ledgerSnapshot(db)
    expectMeaningfulLedgerSnapshot(before)

    const result = await handleExplain(
      db,
      root,
      { scope: 'queue', auditor: 'claude' },
      { spawnAsync: fakeExplainSpawn(prompts, ephemeral) }
    )

    expect(result).toEqual({ status: 200, body: { ok: true, text: ephemeral } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('BEGIN_URTEXT_FACTS')
    expect(prompts[0]).toContain('"source":"status-snapshot"')
    const after = ledgerSnapshot(db)
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).not.toContain(ephemeral)
  })

  test('C028 P5 keeps the exact current short-HEAD invalidation copy beside both decide and approve forms', () => {
    const { db, root } = createWorkspace(
      [
        '## FR001 intent',
        '## C001 manual decision <!-- oracle:manual req:FR001 -->',
        '## C002 high-risk approval <!-- oracle:cmd:true risk:high req:FR001 -->',
      ].join('\n')
    )
    verifyWorkspace(db, root)
    ensureAuditLedger(db)
    const evidence = db
      .prepare('SELECT id FROM evidence WHERE spec_path = ? AND clause_id = ? ORDER BY id DESC LIMIT 1')
      .get('specs/x/spec.md', 'C002') as { id: number } | undefined
    if (evidence === undefined) throw new Error('expected C002 evidence')
    db.prepare('INSERT INTO audit_verdicts (evidence_id, auditor, verdict, note, created_at) VALUES (?, ?, ?, ?, ?)').run(
      evidence.id,
      'test',
      'agree',
      'current evidence covers the clause',
      1
    )

    const snapshot = buildUiSnapshot(db, root)
    const head = snapshot.head
    if (head === null) throw new Error('expected git HEAD')
    const expected = `本次批准绑定 HEAD ${head.slice(0, 7)}；代码再动自动失效，需重审。`
    const queue = renderConsole(snapshot)
    const detail = renderBrief(db, root, 'C002')
    const decisionForm = fragment(queue, '<form class="decide-form"', '</form>')
    const reviewForm = fragment(detail, '<form id="review-form"', '</form>')

    expect(successfulBrief(db, root, 'C002').reviewable).toBe(true)
    expect(decisionForm).toContain('data-state="approval-semantics"')
    expect(decisionForm).toContain(expected)
    expect(reviewForm).toContain('data-state="approval-semantics"')
    expect(reviewForm).toContain(expected)
  })
})
