import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { recordDecision } from '../src/decision.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'
import { buildUiSnapshot, handleDecide, handleReview, handleExplain, handleBrief, handleAuditRun } from '../src/review-ui.js'
import { renderConsolePage } from '../src/ui/render-console.js'
import { renderBriefPage, renderBriefErrorPage } from '../src/ui/render-brief.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { importVerdicts, latestEvidence } from '../src/audit.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A git repo with a manual C001, a runnable C002 (cmd:true), verified. */
const setupRepo = (extraClauseLine?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-'))
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

  test('a decision made at a stale HEAD does not clear the clause', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    // HEAD moves — the decision now describes a prior code state.
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

/** High-risk runnable clause, verified + audit-agreed → review-ready. */
const setupReviewable = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-rv-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), '## FR001 test intent\n## C001 pay guard <!-- oracle:cmd:true risk:high req:FR001 -->')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  for (const e of latestEvidence(db)) importVerdicts(db, [{ evidenceId: e.id, auditor: 'codex', verdict: 'agree' }], 1)
  return root
}

describe('browser high-risk review', () => {
  test('a review-ready high-risk clause exposes review buttons and the AI explain control', () => {
    const root = setupReviewable()
    const brief = handleBrief(db, root, 'specs/x/spec.md', 'C001')

    if (!('ok' in brief.body)) throw new Error('expected a brief')
    expect(brief.body.risk).toBe('high')
    expect(brief.body.reviewable).toBe(true)
    const html = renderBriefPage({
      text: brief.body.text,
      csrfToken: 'tok',
      key: 'specs/x/spec.md#C001',
      briefHash: brief.body.briefHash,
      reviewable: true,
      facts: brief.body.facts,
      view: brief.body.view,
      config: DEFAULT_UI_RENDER_CONFIG,
    })
    expect(html).toContain('高风险代码审查：specs/x/spec.md#C001 pay guard')
    expect(html).toContain('id="explain-btn"')
    expect(html).toContain('/api/explain')
    expect(html).toContain('<option value="omp" selected>')
    expect(html).toContain('id="explain-model" value="deepseek/deepseek-v4-flash"')
    expect(html).toContain("claude: 'sonnet'")
    expect(html).toContain("codex: 'gpt-5.6-terra'")
    expect(html).toContain('explainModel.value = defaultModel[explainAuditor.value]')
    expect(html).toContain('data-v="approve"')
    expect(html).toContain('<option value="traex">Traex</option>')
    expect(html).toContain("traex: 'kimi-k2.6'")
    expect(html).toContain('/api/review')
    // No hard-coded consequence template — the examples come from the AI, not the page.
    expect(html).not.toContain('gate 对它 auto-pass（证据+审计+审查三者皆绿）')
    expect(
      renderBriefPage({
        text: brief.body.text,
        csrfToken: 'tok',
        key: 'specs/x/spec.md#C001',
        briefHash: brief.body.briefHash,
        reviewable: false,
        facts: brief.body.facts,
        view: brief.body.view,
        config: DEFAULT_UI_RENDER_CONFIG,
      })
    ).not.toContain('id="review-form"')
  })

  test('handleExplain rejects malformed input before invoking any client', async () => {
    const root = setupReviewable()
    await expect(handleExplain(db, root, { key: 'specs/x/spec.md#C001' })).resolves.toMatchObject({ status: 400 })
    await expect(handleExplain(db, root, { key: 'nohash', auditor: 'claude' })).resolves.toMatchObject({ status: 400 })
    await expect(handleExplain(db, root, { key: 'specs/x/spec.md#C001', auditor: 'bogus' })).resolves.toMatchObject({ status: 400 })
  })

  test('approve records through recordReview guards with a current brief-hash', () => {
    const root = setupReviewable()
    const key = 'specs/x/spec.md#C001'
    const brief = handleBrief(db, root, 'specs/x/spec.md', 'C001')
    if (!('ok' in brief.body)) throw new Error('expected a brief')
    expect(handleReview(db, root, { key, decision: 'approve', briefHash: brief.body.briefHash }, 'a').status).toBe(400)
    const ok = handleReview(db, root, { key, decision: 'approve', briefHash: brief.body.briefHash, note: 'refund path reviewed' }, 'a')
    expect(ok).toEqual({ status: 200, body: { ok: true } })
  })

  test('approve without a brief-hash or on a low-risk clause is rejected (guards not bypassed)', () => {
    const root = setupReviewable()
    const key = 'specs/x/spec.md#C001'
    expect(handleReview(db, root, { key, decision: 'approve', note: 'x' }, 'a').status).toBe(400)
    expect(handleReview(db, root, { key, decision: 'bogus', note: 'x' }, 'a').status).toBe(400)
  })

  test('reject is conservative — no brief-hash or note required', () => {
    const root = setupReviewable()
    const res = handleReview(db, root, { key: 'specs/x/spec.md#C001', decision: 'reject' }, 'a')
    expect(res).toEqual({ status: 200, body: { ok: true } })
  })
})
