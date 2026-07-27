import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { ensureDecisionLedger, recordDecision } from '../src/decision.js'
import { ensureCodeMap } from '../src/dwarf.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { ensureEvidenceLedger, verifyWorkspace } from '../src/verifier.js'
import { buildUiSnapshot, handleDecide, handleReview, handleExplain, handleBrief, handleAuditRun } from '../src/review-ui.js'
import { renderConsolePage } from '../src/ui/render-console.js'
import { renderBriefPage, renderBriefErrorPage } from '../src/ui/render-brief.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { ensureAuditLedger, importVerdicts, latestEvidence } from '../src/audit.js'
import { ensureReviewLedger } from '../src/review.js'

import type { AsyncSpawn } from '../src/audit-runner.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const textSpawn = (prompts: string[]): AsyncSpawn =>
  ((..._args: unknown[]) => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    Object.assign(child, {
      stdout,
      stdin: {
        end: (prompt: string) => {
          prompts.push(prompt)
          queueMicrotask(() => {
            stdout.emit('data', Buffer.from('temporary explanation'))
            child.emit('close', 0)
          })
        },
      },
      kill: () => {},
    })
    return child
  }) as AsyncSpawn

const ledgerRowCounts = (): Record<string, number> => {
  ensureEvidenceLedger(db)
  ensureAuditLedger(db)
  ensureDecisionLedger(db)
  ensureReviewLedger(db)
  ensureCodeMap(db)
  return Object.fromEntries(
    ['evidence', 'audit_verdicts', 'decisions', 'reviews', 'clause_code_map'].map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()),
    ])
  )
}

const factsFromPrompt = (prompt: string): unknown => {
  const begin = 'BEGIN_URTEXT_FACTS'
  const end = 'END_URTEXT_FACTS'
  const start = prompt.lastIndexOf(begin)
  const finish = prompt.indexOf(end, start + begin.length)
  if (start === -1 || finish === -1 || finish <= start) throw new Error('missing explain facts fence')
  return JSON.parse(prompt.slice(start + begin.length, finish).trim())
}

const isClauseFacts = (value: unknown): value is { manifest: { title: string } } =>
  value !== null &&
  typeof value === 'object' &&
  'manifest' in value &&
  value.manifest !== null &&
  typeof value.manifest === 'object' &&
  'title' in value.manifest &&
  typeof value.manifest.title === 'string'

const isQueueFacts = (value: unknown): value is {
  lanes: { human: { items: { key: string }[]; included: number; omitted: number } }
} =>
  value !== null &&
  typeof value === 'object' &&
  'lanes' in value &&
  value.lanes !== null &&
  typeof value.lanes === 'object' &&
  'human' in value.lanes &&
  value.lanes.human !== null &&
  typeof value.lanes.human === 'object' &&
  'items' in value.lanes.human &&
  Array.isArray(value.lanes.human.items) &&
  'included' in value.lanes.human &&
  typeof value.lanes.human.included === 'number' &&
  'omitted' in value.lanes.human &&
  typeof value.lanes.human.omitted === 'number'

/** A git repo with a manual C001, a runnable C002 (cmd:true), verified. */
const setupRepo = (...extraClauseLines: string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  const lines = ['## FR001 test intent', '## C001 design intent <!-- oracle:manual req:FR001 -->', '## C002 label <!-- oracle:cmd:true req:FR001 -->']
  lines.push(...extraClauseLines)
  writeFileSync(join(root, 'specs/x/spec.md'), lines.join('\n'))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
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

describe('buildUiSnapshot', () => {
  test('undecided manual clause is actionable and pending', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const c1 = snap.clauses.find((c) => c.clauseId === 'C001')!
    expect(c1.decisionVerdict).toBe('none')
    expect(c1.actionable).toBe(true)
    expect(snap.totalManual).toBe(1)
    expect(snap.decided).toBe(0)
  })

  test('a recorded pass at HEAD reflects as decided, not actionable', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    const snap = buildUiSnapshot(db, root)
    const c1 = snap.clauses.find((c) => c.clauseId === 'C001')!
    expect(c1.decisionVerdict).toBe('pass')
    expect(c1.actionable).toBe(false)
    expect(snap.decided).toBe(1)
  })

  test('a runnable clause is never a manual review row', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const c2 = snap.clauses.find((c) => c.clauseId === 'C002')!
    expect(c2.decisionVerdict).toBe('n/a')
    expect(c2.actionable).toBe(false)
  })

  test('a decision made at a stale HEAD does not clear the clause', { timeout: 15_000 }, () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    writeFileSync(join(root, 'other.txt'), 'x')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'move head')
    const snap = buildUiSnapshot(db, root)
    const c1 = snap.clauses.find((c) => c.clauseId === 'C001')!
    expect(c1.decisionVerdict).toBe('none')
    expect(c1.actionable).toBe(true)
  })
})

describe('renderConsolePage', () => {
  test('actionable row renders decide buttons; decided row does not', () => {
    const root = setupRepo()
    let html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('data-key="specs/x/spec.md#C001"')
    expect(html).toContain('data-v="pass"')
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).not.toContain('data-key="specs/x/spec.md#C001"')
  })

  test('runnable clause never gets decide buttons (it may sit in the agent lane)', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).not.toContain('data-key="specs/x/spec.md#C002"')
  })

  test('csrf token is embedded and a hostile title cannot break the markup', () => {
    const root = setupRepo(`## C003 <script>'"&x <!-- oracle:manual req:FR001 -->`)
    const html = renderConsolePage(buildUiSnapshot(db, root), 'my-token')
    expect(html).toContain('<meta name="csrf-token" content="my-token">')
    expect(html).not.toContain('<script>\'"&x')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('handleDecide', () => {
  test('a valid manual decision with a reason records and returns 200', () => {
    const root = setupRepo()
    const res = handleDecide(
      db,
      root,
      { key: 'specs/x/spec.md#C001', verdict: 'pass', note: 'intent matches the shipped design' },
      'alice'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(buildUiSnapshot(db, root).decided).toBe(1)
  })

  test('pass needs a one-sentence reason; fail stays conservative without one', () => {
    const root = setupRepo()
    expect(handleDecide(db, root, { key: 'specs/x/spec.md#C001', verdict: 'pass' }, 'a').status).toBe(400)
    expect(
      handleDecide(db, root, { key: 'specs/x/spec.md#C001', verdict: 'pass', note: '   ' }, 'a').status
    ).toBe(400)
    expect(buildUiSnapshot(db, root).decided).toBe(0)
    expect(handleDecide(db, root, { key: 'specs/x/spec.md#C001', verdict: 'fail' }, 'a').status).toBe(200)
  })

  test('a non-manual clause is rejected (P2 guard)', () => {
    const root = setupRepo()
    const res = handleDecide(db, root, { key: 'specs/x/spec.md#C002', verdict: 'pass', note: 'x' }, 'alice')
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })

  test('an unknown clause is rejected', () => {
    const root = setupRepo()
    const res = handleDecide(db, root, { key: 'specs/x/spec.md#C999', verdict: 'pass', note: 'x' }, 'alice')
    expect(res.status).toBe(400)
  })

  test('a malformed verdict or key is rejected without touching the ledger', () => {
    const root = setupRepo()
    expect(handleDecide(db, root, { key: 'specs/x/spec.md#C001', verdict: 'maybe' }, 'a').status).toBe(400)
    expect(handleDecide(db, root, { key: 'nohash', verdict: 'pass', note: 'x' }, 'a').status).toBe(400)
    expect(handleDecide(db, root, 'not-an-object', 'a').status).toBe(400)
    expect(buildUiSnapshot(db, root).decided).toBe(0)
  })
})

describe('handleAuditRun', () => {
  test('rejects malformed client selections before invoking an auditor', async () => {
    await expect(handleAuditRun(db, { auditor: 'unknown' })).resolves.toMatchObject({ status: 400 })
    await expect(handleAuditRun(db, { auditor: 'claude', profile: 'audit' })).resolves.toMatchObject({ status: 400 })
  })
})

describe('operator console (v3)', () => {
  test('snapshot carries the status queue: manual undecided sits in the human lane', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const item = snap.status.items.find((entry) => entry.key === 'specs/x/spec.md#C001')
    expect(item).toMatchObject({ lane: 'human', primary: 'manual_undecided' })
  })

  test('handleBrief returns the hash + the shared rendered text', () => {
    const root = setupRepo()
    const ok = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    expect(ok.status).toBe(200)
    if (!('ok' in ok.body)) throw new Error('expected a brief')
    expect(ok.body.briefHash).toMatch(/^[0-9a-f]{12}$/)
    expect(ok.body.text).toContain('design intent')
    expect(ok.body.text).toContain('brief-hash:')
    expect(handleBrief(db, root, 'specs/x/spec.md', 'C999').status).toBe(404)
    expect(handleBrief(db, root, null, 'C001').status).toBe(400)
  })

  test('brief api exposes a typed impact projection without inventing facts', () => {
    const root = setupRepo('## C003 guarded path <!-- oracle:cmd:true risk:high refs:specs/x/spec.md#C002 req:FR001 -->')
    db.prepare('DELETE FROM evidence WHERE spec_path = ? AND clause_id = ?').run('specs/x/spec.md', 'C003')
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C003')
    expect(result.status).toBe(200)
    if (!('ok' in result.body)) throw new Error('expected a brief')
    expect(result.body.view).toMatchObject({
      schema: 'urtext.spec-impact/1',
      target: { specPath: 'specs/x/spec.md', clauseId: 'C003' },
      risk: 'high',
      stale: false,
      hasEvidence: false,
      requirementBindings: [
        {
          state: 'resolved',
          rawTarget: 'FR001',
          target: {
            specPath: 'specs/x/spec.md',
            reqId: 'FR001',
            title: 'test intent',
          },
        },
      ],
    })
    expect(result.body.view.impact.affectedClauses).toEqual([])
    expect(result.body.view.mappings).toEqual([])
  })

  test('brief page renders fresh and stale evidence as distinct states', () => {
    const root = setupRepo('## C003 guarded path <!-- oracle:cmd:true risk:high req:FR001 -->')
    const fresh = handleBrief(db, root, 'specs/x/spec.md', 'C003')
    if (!('ok' in fresh.body)) throw new Error('expected a brief')
    const freshHtml = renderBriefPage({
      text: fresh.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C003',
      briefHash: fresh.body.briefHash,
      reviewable: false,
      facts: fresh.body.facts,
      view: fresh.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(freshHtml).toContain('data-state="fresh"')
    db.prepare('UPDATE evidence SET invalidated_at = 1 WHERE spec_path = ? AND clause_id = ?').run('specs/x/spec.md', 'C003')
    const stale = handleBrief(db, root, 'specs/x/spec.md', 'C003')
    if (!('ok' in stale.body)) throw new Error('expected a brief')
    const staleHtml = renderBriefPage({
      text: stale.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C003',
      briefHash: stale.body.briefHash,
      reviewable: false,
      facts: stale.body.facts,
      view: stale.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(staleHtml).toContain('data-state="stale"')
    expect(staleHtml).not.toContain('data-state="fresh"')
  })

  test('brief page lists dependent clauses as potential impact, not stale state', () => {
    const root = setupRepo('## C003 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C002 req:FR001 -->')
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C002')
    if (!('ok' in result.body)) throw new Error('expected a brief')
    const html = renderBriefPage({
      text: result.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C002',
      briefHash: result.body.briefHash,
      reviewable: false,
      facts: result.body.facts,
      view: result.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(result.body.view.impact.affectedClauses).toEqual([{ specPath: 'specs/x/spec.md', clauseId: 'C003' }])
    expect(html).toContain('Stale Dependencies / 下游依赖')
    expect(html).toContain('/brief?spec=specs%2Fx%2Fspec.md&amp;clause=C003')
  })

  test('brief page distinguishes risk, evidence, mappings, and potential impact', () => {
    const root = setupRepo('## C003 guarded path <!-- oracle:cmd:true risk:high req:FR001 -->')
    db.prepare('DELETE FROM evidence WHERE spec_path = ? AND clause_id = ?').run('specs/x/spec.md', 'C003')
    const result = handleBrief(db, root, 'specs/x/spec.md', 'C003')
    if (!('ok' in result.body)) throw new Error('expected a brief')
    const html = renderBriefPage({
      text: result.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C003',
      briefHash: result.body.briefHash,
      reviewable: false,
      facts: result.body.facts,
      view: result.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(html).toContain('data-state="risk-high"')
    expect(html).toContain('data-state="no-evidence"')
    expect(html).toContain('尚无映射代码')
    expect(html).toContain('无下游依赖')
    expect(html).toContain('映射状态')
  })

  test('brief error page escapes the refusal and never emits a risk conclusion', () => {
    const html = renderBriefErrorPage('[unknown_clause] <script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('data-state="risk-')
    expect(html).toContain('data-state="error"')
  })

  test('high-risk manual decide from the ui needs the brief-hash it can fetch', () => {
    const root = setupRepo('## C003 ship gate <!-- oracle:manual risk:high req:FR001 -->')
    const key = 'specs/x/spec.md#C003'
    expect(handleDecide(db, root, { key, verdict: 'pass', note: 'x' }, 'a').status).toBe(400)
    const brief = handleBrief(db, root, 'specs/x/spec.md', 'C003')
    if (!('ok' in brief.body)) throw new Error('expected a brief')
    const res = handleDecide(
      db,
      root,
      { key, verdict: 'pass', briefHash: brief.body.briefHash, note: 'gate reviewed against brief' },
      'a'
    )
    expect(res.status).toBe(200)
  })
})

describe('explain boundary', () => {
  test('rejects invalid request shapes before invoking any client', async () => {
    const calls: string[] = []
    const forbidden = (() => {
      calls.push('spawned')
      throw new Error('must not spawn')
    }) as AsyncSpawn
    for (const input of [
      { key: 'specs/x/spec.md#C001' },
      { key: 'specs/x/spec.md#C001', scope: 'queue', auditor: 'claude' },
      { auditor: 'claude' },
      { scope: 'other', auditor: 'claude' },
      { key: 'specs/x/spec.md#C001', auditor: 'bogus' },
    ]) {
      await expect(handleExplain(db, '', input, { spawnAsync: forbidden })).resolves.toMatchObject({ status: 400 })
    }
    expect(calls).toEqual([])
  })

  test('rejects a non-current key before invoking any client', async () => {
    const root = setupRepo()
    const calls: string[] = []
    const forbidden = (() => {
      calls.push('spawned')
      throw new Error('must not spawn')
    }) as AsyncSpawn
    await expect(
      handleExplain(db, root, { key: 'specs/x/spec.md#not-clause', auditor: 'claude' }, { spawnAsync: forbidden })
    ).resolves.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })

  test('rejects an agent-lane clause key before invoking any client', async () => {
    const root = setupRepo()
    const calls: string[] = []
    const forbidden = (() => {
      calls.push('spawned')
      throw new Error('must not spawn')
    }) as AsyncSpawn
    await expect(
      handleExplain(db, root, { key: 'specs/x/spec.md#C002', auditor: 'claude' }, { spawnAsync: forbidden })
    ).resolves.toEqual({ status: 409, body: { error: 'item is not in the current human queue' } })
    expect(calls).toEqual([])
  })

  test('explains only a current human unmapped item from status facts without ledger writes', { timeout: 15_000 }, async () => {
    const root = setupRepo()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/impl.ts'), 'export const current = 1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'track implementation')
    writeFileSync(join(root, 'src/impl.ts'), 'export const current = 2\n')

    const snapshot = buildUiSnapshot(db, root)
    const item = snapshot.status.items.find(
      (candidate) => candidate.kind === 'unmapped' && candidate.lane === 'human'
    )
    if (item === undefined) throw new Error('expected a current human unmapped status item')
    expect(item).toMatchObject({
      key: 'src/impl.ts:1-1',
      primary: 'unmapped',
      next: '`urtext map <spec>#<clause> <range>` | `urtext ack <range> <reason>` | write back to spec',
    })

    const prompts: string[] = []
    const before = ledgerRowCounts()
    await expect(
      handleExplain(db, root, { key: `${item.key}-stale`, auditor: 'claude' }, { spawnAsync: textSpawn(prompts) })
    ).resolves.toEqual({ status: 409, body: { error: 'item is not in the current human queue' } })
    await expect(
      handleExplain(db, root, { key: item.key, auditor: 'claude' }, { spawnAsync: textSpawn(prompts) })
    ).resolves.toEqual({ status: 200, body: { ok: true, text: 'temporary explanation' } })

    expect(prompts).toHaveLength(1)
    const facts = factsFromPrompt(prompts[0]!)
    expect(facts).toMatchObject({
      source: 'status-item',
      head: snapshot.status.head,
      item: {
        key: item.key,
        kind: 'unmapped',
        lane: 'human',
        primary: 'unmapped',
        next: item.next,
        filePath: 'src/impl.ts',
        lineStart: 1,
        lineEnd: 1,
      },
    })
    expect(facts).not.toHaveProperty('manifest')
    expect(ledgerRowCounts()).toEqual(before)
  })

  test('fences manifest-only facts and persists no response', async () => {
    const root = setupRepo()
    const prompts: string[] = []
    const result = await handleExplain(
      db,
      root,
      { key: 'specs/x/spec.md#C001', auditor: 'claude' },
      { spawnAsync: textSpawn(prompts) }
    )
    expect(result).toEqual({ status: 200, body: { ok: true, text: 'temporary explanation' } })
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]!
    expect(prompt).toContain('BEGIN_URTEXT_FACTS')
    expect(prompt).toContain('END_URTEXT_FACTS')
    expect(prompt).toContain('## 为什么需要你')
    expect(prompt).toContain('## 批准与拒绝分别意味着什么')
    expect(prompt).toContain('## 哪里有风险信号')
    expect(prompt).toContain('JSON 字段路径')
    expect(prompt).not.toContain('evidenceOutput')
    expect(prompt).not.toContain('briefHistory')
    expect(prompt).not.toContain('temporary explanation')
  })

  test('keeps large UTF-8 clause facts within the configured byte cap', async () => {
    const previous = process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
    process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = '1024'
    try {
      const root = setupRepo('## C003 ' + '危'.repeat(12_000) + ' <!-- oracle:manual req:FR001 -->')
      const prompts: string[] = []
      await expect(
        handleExplain(db, root, { key: 'specs/x/spec.md#C003', auditor: 'claude' }, { spawnAsync: textSpawn(prompts) })
      ).resolves.toMatchObject({ status: 200 })
      const facts = factsFromPrompt(prompts[0]!)
      if (!isClauseFacts(facts)) throw new Error('expected clause explain facts')
      expect(Buffer.byteLength(JSON.stringify(facts), 'utf8')).toBeLessThanOrEqual(1024)
      expect(facts.manifest.title.endsWith('…')).toBe(true)
      expect(Buffer.from(facts.manifest.title, 'utf8').toString('utf8')).toBe(facts.manifest.title)
    } finally {
      if (previous === undefined) delete process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
      else process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = previous
    }
  })

  test('falls back from an invalid byte cap to the named default', async () => {
    const previous = process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
    process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = '100'
    try {
      const root = setupRepo('## C003 ' + '危'.repeat(12_000) + ' <!-- oracle:manual req:FR001 -->')
      const prompts: string[] = []
      await expect(
        handleExplain(db, root, { key: 'specs/x/spec.md#C003', auditor: 'claude' }, { spawnAsync: textSpawn(prompts) })
      ).resolves.toMatchObject({ status: 200 })
      const facts = factsFromPrompt(prompts[0]!)
      const bytes = Buffer.byteLength(JSON.stringify(facts), 'utf8')
      expect(bytes).toBeGreaterThan(1024)
      expect(bytes).toBeLessThanOrEqual(24 * 1024)
    } finally {
      if (previous === undefined) delete process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
      else process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = previous
    }
  })

  test('serializes each queue lane as a deterministic prefix with an omitted tail', async () => {
    const previous = process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
    process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = '1024'
    try {
      const root = setupRepo(
        `## C003 ${'危'.repeat(600)} <!-- oracle:manual req:FR001 -->`,
        '## C004 short tail <!-- oracle:manual req:FR001 -->',
        '## C005 short tail <!-- oracle:manual req:FR001 -->'
      )
      const prompts: string[] = []
      const input = { scope: 'queue', auditor: 'claude' }
      await expect(handleExplain(db, root, input, { spawnAsync: textSpawn(prompts) })).resolves.toMatchObject({ status: 200 })
      await expect(handleExplain(db, root, input, { spawnAsync: textSpawn(prompts) })).resolves.toMatchObject({ status: 200 })
      const first = factsFromPrompt(prompts[0]!)
      if (!isQueueFacts(first)) throw new Error('expected queue explain facts')
      const second = factsFromPrompt(prompts[1]!)
      const human = buildUiSnapshot(db, root).status.items.filter((item) => item.lane === 'human')
      expect(first).toEqual(second)
      expect(first.lanes.human.items.map((item) => item.key)).toEqual(human.slice(0, first.lanes.human.included).map((item) => item.key))
      expect(first.lanes.human.included).toBeLessThan(human.length)
      expect(first.lanes.human.omitted).toBe(human.length - first.lanes.human.included)
      expect(first.lanes.human.items.map((item) => item.key)).not.toContain('specs/x/spec.md#C004')
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(1024)
    } finally {
      if (previous === undefined) delete process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES
      else process.env.URTEXT_EXPLAIN_MAX_FACT_BYTES = previous
    }
  })
})
