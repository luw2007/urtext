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
import { buildUiSnapshot, renderPage, handleDecide, handleBrief, handleAuditRun } from '../src/review-ui.js'

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
  const lines = ['## C001 design intent <!-- oracle:manual -->', '## C002 label <!-- oracle:cmd:true -->']
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

describe('renderPage', () => {
  test('actionable row renders decide buttons; decided row does not', () => {
    const root = setupRepo()
    let html = renderPage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('data-key="specs/x/spec.md#C001" data-v="pass"')
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    html = renderPage(buildUiSnapshot(db, root), 'tok')
    expect(html).not.toContain('data-key="specs/x/spec.md#C001"')
    expect(html).toContain('✓ pass')
  })

  test('runnable clause never gets decide buttons (it may sit in the agent lane)', () => {
    const root = setupRepo()
    const html = renderPage(buildUiSnapshot(db, root), 'tok')
    expect(html).not.toContain('data-key="specs/x/spec.md#C002"')
  })

  test('unaudited agent work renders selectable headless audit controls', () => {
    const root = setupRepo()
    const html = renderPage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('id="audit-runner"')
    expect(html).toContain('value="claude"')
    expect(html).toContain('value="codex"')
    expect(html).toContain('value="omp"')
    expect(html).toContain('/api/audit-run')
  })

  test('csrf token is embedded and a hostile title cannot break the markup', () => {
    const root = setupRepo(`## C003 <script>'"&x <!-- oracle:manual -->`)
    const html = renderPage(buildUiSnapshot(db, root), 'my-token')
    expect(html).toContain('<meta name="csrf" content="my-token">')
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

  test('high-risk manual decide from the ui needs the brief-hash it can fetch', () => {
    const root = setupRepo('## C003 ship gate <!-- oracle:manual risk:high -->')
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
