import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { recordDecision } from '../src/decision.js'
import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot } from '../src/review-ui.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'
import { renderConsolePage } from '../src/ui/render-console.js'
import { CONSOLE_SCRIPT } from '../src/ui/console-script.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A git repo with a manual C001, a runnable C002 (cmd:true), verified. */
const setupRepo = (extraClauseLine?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-console-'))
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

// ---------------------------------------------------------------------------
// Page shell / landmarks / accessibility contract (§5.1)
// ---------------------------------------------------------------------------

describe('renderConsolePage — shell and landmarks', () => {
  test('skip link is the first focusable element in the body; header/nav/main follow', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const bodyStart = html.indexOf('<body>')
    const skipIdx = html.indexOf('<a class="skip" href="#main">')
    const headerIdx = html.indexOf('<header>')
    const navIdx = html.indexOf('<nav aria-label="页面导航">')
    const mainIdx = html.indexOf('<main id="main">')
    expect(skipIdx).toBeGreaterThan(bodyStart)
    expect(skipIdx).toBeLessThan(headerIdx)
    expect(headerIdx).toBeLessThan(navIdx)
    expect(navIdx).toBeLessThan(mainIdx)
    expect(html).toContain('<html lang="zh-CN">')
  })

  test('exactly one h1, header has no nav links', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1)
    expect(html).toContain('<h1 id="console-title">urtext console</h1>')
    const headerHtml = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
    expect(headerHtml).not.toContain('<a href')
  })

  test('nav contains the four fixed links in order', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(['#your-queue-title', '#agent-lane-title', '#all-specs', '/'])
  })

  test('every aria-labelledby target id exists exactly once', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const refs = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const id of refs) {
      const count = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length
      expect(count).toBe(1)
    }
  })

  test('all tables have a caption and column headers with scope=col', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const tables = [...html.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0])
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) {
      expect(table).toContain('<caption>')
      expect(table).toContain('<th scope="col">')
    }
  })

  test('csrf token is embedded via the shared meta contract', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'my-token')
    expect(html).toContain('<meta name="csrf-token" content="my-token">')
  })

  test('script contains no prompt/alert calls and no inline event attributes', () => {
    expect(CONSOLE_SCRIPT).not.toMatch(/\bprompt\(/)
    expect(CONSOLE_SCRIPT).not.toMatch(/\balert\(/)
    expect(CONSOLE_SCRIPT).not.toMatch(/\son\w+=/)
  })
})

// ---------------------------------------------------------------------------
// Header, summary, wip banner (§3.1 items 2/4)
// ---------------------------------------------------------------------------

describe('renderConsolePage — header and summary', () => {
  test('header shows short HEAD sha and clean-worktree state (no dirty chip)', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage(snap, 'tok')
    expect(html).toContain(`<code>${snap.head!.slice(0, 7)}</code>`)
    expect(html).not.toContain('worktree dirty')
  })

  test('dirty worktree renders the warn-toned chip in the header', () => {
    const root = setupRepo()
    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 design intent <!-- oracle:manual -->\nchanged\n')
    const snap = buildUiSnapshot(db, root)
    expect(snap.dirty).toBe(true)
    const html = renderConsolePage(snap, 'tok')
    expect(html).toContain('⚠ worktree dirty')
    expect(html).toContain('data-tone="warn"')
  })

  test('summary strip reports counts and decided/total manual', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage(snap, 'tok')
    expect(html).toContain(
      `${snap.status.counts.human} for you, ${snap.status.counts.agent} for the agent, ${snap.status.counts.autoPass} auto-pass · ${snap.decided}/${snap.totalManual} manual decided`
    )
  })

  test('wip banner is tagged data-banner="wip" and preserves the original text', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    snap.status.wip.exceeded = true
    snap.status.wip.limit = 1
    snap.status.counts.human = 5
    const html = renderConsolePage(snap, 'tok')
    expect(html).toContain('data-banner="wip"')
    expect(html).toContain('warning: human queue 5 exceeds wip limit 1 — consider smaller changes')
  })

  test('audit result notice renders with the fixed id', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok', 'imported 39 verdict(s); 22 disagreement(s) moved to Your queue.')
    expect(html).toContain('id="audit-result"')
    expect(html).toContain('22 disagreement(s) moved to Your queue.')
  })
})

// ---------------------------------------------------------------------------
// Unmapped banner (§3.1 item 5) — data-banner values, exact command text
// ---------------------------------------------------------------------------

describe('renderConsolePage — unmapped banner', () => {
  test('clean workspace renders no banner', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage({ ...snap, unmapped: [], unmappedError: null }, 'tok')
    expect(html).not.toContain('data-banner="unmapped"')
    expect(html).not.toContain('data-banner="unmapped-error"')
  })

  test('unmapped hunks render role=alert, exact command templates, escaped ranges', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage({ ...snap, unmapped: [{ filePath: '<bad>.ts', lineStart: 2, lineEnd: 3 }], unmappedError: null }, 'tok')
    expect(html).toContain('data-banner="unmapped"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-labelledby="workspace-alert-title"')
    expect(html).toContain('id="workspace-alert-title"')
    expect(html).toContain('&lt;bad&gt;.ts:2-3')
    expect(html).toContain('urtext map &lt;spec&gt;#&lt;clause&gt; &lt;bad&gt;.ts:2-3')
    expect(html).toContain('urtext ack &lt;bad&gt;.ts:2-3 &lt;reason&gt;')
    expect(html).not.toContain('data-banner="unmapped-error"')
  })

  test('detection failure renders the error banner, distinct from empty', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage({ ...snap, unmapped: [], unmappedError: '<git failed>' }, 'tok')
    expect(html).toContain('data-banner="unmapped-error"')
    expect(html).toContain('&lt;git failed&gt;')
    expect(html).not.toContain('data-banner="unmapped"')
  })
})

// ---------------------------------------------------------------------------
// Your queue — accessible inline decide forms (§3.1 item 6)
// ---------------------------------------------------------------------------

describe('renderConsolePage — Your queue', () => {
  test('an actionable manual clause renders an inline decide form, not prompt/alert', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('data-key="specs/x/spec.md#C001"')
    expect(html).toContain('class="decide-form"')
    expect(html).toContain('data-v="pass"')
    expect(html).toContain('data-v="fail"')
    expect(html).toContain('class="decision-msg" aria-live="polite"')
    expect(html).not.toMatch(/\bprompt\(/)
    expect(html).not.toMatch(/\balert\(/)
  })

  test('the decide form textarea has an explicit label', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const labelMatch = html.match(/<label for="(decision-note-\d+)">Reason<\/label>/)
    expect(labelMatch).not.toBeNull()
    expect(html).toContain(`<textarea id="${labelMatch![1]}" name="note">`)
  })

  test('a decided clause no longer renders a decide form for that key', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).not.toContain('data-key="specs/x/spec.md#C001"')
  })

  test('empty human queue keeps a caption/header table with the preserved empty text', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage({ ...snap, status: { ...snap.status, items: [] } }, 'tok')
    expect(html).toContain('nothing — prerequisites pending or all clear')
    expect(html).toContain('<caption>Your queue (0)</caption>')
  })

  test('escapes clause title, key and reason content', () => {
    const root = setupRepo(`## C003 <script>'"&x <!-- oracle:manual -->`)
    const html = renderConsolePage(buildUiSnapshot(db, root), 'my-token')
    expect(html).not.toContain('<script>\'"&x')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// Agent lane — conditional open/closed, deduped hints (§3.1 item 7)
// ---------------------------------------------------------------------------

describe('renderConsolePage — Agent lane', () => {
  test('audit form sits outside the <details> lane', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const detailsIdx = html.indexOf('<details data-section="agent-lane"')
    const auditIdx = html.indexOf('id="audit-runner"')
    if (auditIdx !== -1) expect(auditIdx).toBeLessThan(detailsIdx)
  })

  test('lane is collapsed by default when the human queue is non-empty', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    const detailsTag = html.slice(html.indexOf('<details data-section="agent-lane"'), html.indexOf('<summary id="agent-lane-title"'))
    expect(detailsTag).not.toContain(' open')
  })

  test('lane is open by default when the human queue is empty', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const html = renderConsolePage({ ...snap, status: { ...snap.status, items: snap.status.items.filter((i) => i.lane !== 'human') } }, 'tok')
    const detailsTag = html.slice(html.indexOf('<details data-section="agent-lane"'), html.indexOf('<summary id="agent-lane-title"'))
    expect(detailsTag).toContain(' open')
  })
  test('duplicate next hints are deduped into a single lane-top list', () => {
    const root = setupRepo()
    const snap = buildUiSnapshot(db, root)
    const agentTemplate = snap.status.items.find((i) => i.lane === 'agent')
    if (!agentTemplate) return
    const duplicated = { ...snap, status: { ...snap.status, items: [agentTemplate, { ...agentTemplate, key: `${agentTemplate.key}-dup` }] } }
    const html = renderConsolePage(duplicated, 'tok')
    const laneHtml = html.slice(html.indexOf('<details data-section="agent-lane"'), html.indexOf('</details>'))
    const escapedNext = agentTemplate.next.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]!)
    const hintOccurrences = laneHtml.split(escapedNext).length - 1
    expect(hintOccurrences).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// All Specs — grouped by spec (§3.1 item 8)
// ---------------------------------------------------------------------------

describe('renderConsolePage — All Specs', () => {
  test('groups clauses by specPath with a stable heading id per group', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('id="all-specs"')
    expect(html).toContain('id="spec-group-0-title"')
    expect(html).toContain('data-clause="specs/x/spec.md#C001"')
    expect(html).toContain('data-clause="specs/x/spec.md#C002"')
    expect(html).toContain('<code>specs/x/spec.md</code>')
  })

  test('evidence column renders as a status chip with the data-state vocabulary', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toMatch(/data-state="(fresh|no-evidence)"/)
  })
})

// ---------------------------------------------------------------------------
// Decided table (§3.1 item 9)
// ---------------------------------------------------------------------------

describe('renderConsolePage — Decided', () => {
  test('decided clauses render pass/fail as a text+symbol status chip', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('id="decided-title"')
    expect(html).toContain('✓ pass')
    expect(html).toContain('data-tone="ok"')
  })

  test('no decided clauses renders the preserved empty text', () => {
    const root = setupRepo()
    const html = renderConsolePage(buildUiSnapshot(db, root), 'tok')
    expect(html).toContain('none yet')
  })
})
