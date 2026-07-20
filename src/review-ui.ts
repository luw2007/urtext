/**
 * Operator console core (pure logic) — the model and rendering behind
 * `urtext ui`. v1 was a manual-decision panel; the operator-flow plan (v3)
 * upgrades it to the console: the two-lane status queue, inline brief access,
 * and decide buttons that quote the brief-hash.
 *
 * Truth sources are unchanged (C104, P2): reads go through `buildStatus`/
 * `adjudicate`, writes through `recordDecision` — the same guarded domain path
 * as the CLI, so a high-risk manual clause cannot be passed from the browser
 * without the current brief-hash (C018; the guard lives in decision.ts, not
 * here). High-risk CODE review stays CLI-only: the panel shows the pending
 * item and the command, but code is the only reviewable fact (P5) and this
 * page does not show code.
 */
import type { Database } from 'better-sqlite3'

import { buildBrief, renderBriefText, type BriefHistoryLine, type ClauseTarget } from './brief.js'
import { detectUnmapped } from './dwarf.js'
import { adjudicate } from './gate.js'
import { buildStatus, type StatusItem, type StatusReport } from './status.js'
import { currentHead, listDecisions, recordDecision } from './decision.js'
import { listReviews, worktreeDirty } from './review.js'

export interface UiClause {
  specPath: string
  clauseId: string
  title: string
  risk: 'low' | 'high'
  /** Human decision at the current HEAD for a manual clause. */
  decisionVerdict: 'pass' | 'fail' | 'none' | 'n/a'
  /** A manual clause still awaiting a human decision — render pass/fail buttons. */
  actionable: boolean
}

export interface UiSnapshot {
  head: string | null
  /** Uncommitted worktree state — re-queues approved high-risk clauses. */
  dirty: boolean
  /** The operator queue (same builder as `urtext status`). */
  status: StatusReport
  clauses: UiClause[]
  /** Manual clauses decided at HEAD / total manual clauses. */
  decided: number
  totalManual: number
}

/** Build the console model: status lanes + the manual-decision view. */
export const buildUiSnapshot = (db: Database, root: string): UiSnapshot => {
  const head = currentHead(root)
  const dirty = worktreeDirty(root) ?? false
  const unmappedReport = detectUnmapped(db, root)
  const unmapped = 'error' in unmappedReport ? [] : unmappedReport.unmapped
  const status = buildStatus(db, { head, unmapped, dirtyWorktree: dirty })
  const report = adjudicate(db, unmapped.length, head ?? undefined, { dirtyWorktree: dirty })
  const clauses: UiClause[] = report.decisions.map((d) => {
    const isManual = d.decisionVerdict !== 'n/a'
    return {
      specPath: d.specPath,
      clauseId: d.clauseId,
      title: d.title,
      risk: d.risk,
      decisionVerdict: d.decisionVerdict,
      actionable: isManual && d.decisionVerdict === 'none',
    }
  })
  const manual = clauses.filter((c) => c.decisionVerdict !== 'n/a')
  return {
    head,
    dirty,
    status,
    clauses,
    decided: manual.filter((c) => c.decisionVerdict === 'pass' || c.decisionVerdict === 'fail').length,
    totalManual: manual.length,
  }
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]!)

const briefHref = (specPath: string, clauseId: string): string =>
  `/brief?spec=${encodeURIComponent(specPath)}&clause=${encodeURIComponent(clauseId)}`

const queueRow = (item: StatusItem): string => {
  const risk = item.risk === 'high' ? ' <span style="color:#c00">[high]</span>' : ''
  const secondary = item.reasons.length > 1 ? ` <small>(+${esc(item.reasons.slice(1).join(', '))})</small>` : ''
  const title = item.title ? ` ${esc(item.title)}` : ''
  let action: string
  if (item.kind === 'unmapped') {
    action = '<small>map / ack / spec write-back via CLI</small>'
  } else {
    const key = `${item.specPath}#${item.clauseId}`
    const brief = `<a href="${esc(briefHref(item.specPath!, item.clauseId!))}">brief</a>`
    action = item.reasons.includes('manual_undecided')
      ? `${brief} <button data-key="${esc(key)}" data-v="pass">✓ pass</button>` +
        `<button data-key="${esc(key)}" data-v="fail">✗ fail</button>`
      : `${brief} <small>${esc(item.next)}</small>`
  }
  return `<tr><td>${esc(item.key)}${title}${risk}</td><td>${esc(item.primary)}${secondary}</td><td>${action}</td></tr>`
}

/** Render the self-contained console page. No inline handlers; a delegated
 * listener reads `data-*`, fetches the brief-hash, and posts with the session
 * CSRF token. */
export const renderPage = (snapshot: UiSnapshot, csrfToken: string): string => {
  const human = snapshot.status.items.filter((item) => item.lane === 'human')
  const agent = snapshot.status.items.filter((item) => item.lane === 'agent')
  const decidedRows = snapshot.clauses
    .filter((c) => c.decisionVerdict === 'pass' || c.decisionVerdict === 'fail')
    .map((c) => {
      const state =
        c.decisionVerdict === 'pass' ? '<b style="color:#0a0">✓ pass</b>' : '<b style="color:#c00">✗ fail</b>'
      return `<tr><td>${esc(`${c.specPath}#${c.clauseId}`)} ${esc(c.title)}</td><td>${state}</td><td><a href="${esc(briefHref(c.specPath, c.clauseId))}">brief</a></td></tr>`
    })
    .join('')
  const humanRows = human.map(queueRow).join('')
  const agentRows = agent.map(queueRow).join('')
  const dirty = snapshot.dirty
    ? ' <span style="color:#b80">· worktree dirty</span>'
    : ''
  const wip = snapshot.status.wip.exceeded
    ? `<p style="color:#b80">warning: human queue ${snapshot.status.counts.human} exceeds wip limit ${snapshot.status.wip.limit} — consider smaller changes</p>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="csrf" content="${esc(csrfToken)}">
<title>urtext console</title>
<style>body{font:14px system-ui;margin:2rem;max-width:70rem}
table{border-collapse:collapse;width:100%;margin-bottom:1.2rem}td{padding:.4rem .6rem;border-bottom:1px solid #eee}
h3{margin:.4rem 0}button{margin-left:.3rem;cursor:pointer}</style></head><body>
<h2>urtext console <small style="color:#999">· Ctrl-C to quit</small></h2>
<p>HEAD ${esc(snapshot.head?.slice(0, 7) ?? 'n/a')}${dirty} — ${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided</p>
${wip}
<h3>Your queue (${human.length})</h3>
<table>${humanRows || '<tr><td>nothing — prerequisites pending or all clear</td></tr>'}</table>
<h3>Agent lane (${agent.length})</h3>
<table>${agentRows || '<tr><td>empty</td></tr>'}</table>
<h3>Decided manual clauses at HEAD (${decidedRows ? snapshot.decided : 0})</h3>
<table>${decidedRows || '<tr><td>none yet</td></tr>'}</table>
<script>
const csrf = document.querySelector('meta[name=csrf]').content
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-key]'); if (!b) return
  const key = b.dataset.key
  const cut = key.lastIndexOf('#')
  const qs = 'spec=' + encodeURIComponent(key.slice(0, cut)) + '&clause=' + encodeURIComponent(key.slice(cut + 1))
  const br = await fetch('/api/brief?' + qs)
  const bj = await br.json()
  if (bj.error) { alert(bj.error); return }
  const r = await fetch('/api/decide', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf': csrf },
    body: JSON.stringify({ key, verdict: b.dataset.v, briefHash: bj.briefHash }) })
  const j = await r.json(); if (j.error) { alert(j.error); return }
  location.reload()
})
</script></body></html>`
}

/** Review + decision ledger lines for one clause, newest first (brief display). */
export const briefHistory = (db: Database, target: ClauseTarget): BriefHistoryLine[] =>
  [
    ...listReviews(db)
      .filter((r) => r.specPath === target.specPath && r.clauseId === target.clauseId)
      .map((r) => ({
        when: r.createdAt,
        what: `review ${r.decision} @ ${r.commitSha.slice(0, 7)} by ${r.reviewer}`,
        note: r.note,
      })),
    ...listDecisions(db)
      .filter((d) => d.specPath === target.specPath && d.clauseId === target.clauseId)
      .map((d) => ({
        when: d.createdAt,
        what: `decide ${d.verdict} @ ${d.commitSha.slice(0, 7)} by ${d.decider}`,
        note: d.note,
      })),
  ].sort((a, b) => b.when - a.when)

export interface BriefApiResult {
  status: number
  body: { ok: true; briefHash: string; text: string } | { error: string }
}

/** Build one clause's brief for the console (JSON api + the /brief page). */
export const handleBrief = (db: Database, root: string, spec: unknown, clause: unknown): BriefApiResult => {
  if (typeof spec !== 'string' || typeof clause !== 'string' || !/^C\d+$/.test(clause)) {
    return { status: 400, body: { error: 'need ?spec=<spec-path>&clause=C<n>' } }
  }
  const target = { specPath: spec, clauseId: clause }
  const outcome = buildBrief(db, root, target)
  if (outcome.kind === 'refused') {
    return {
      status: outcome.code === 'unknown_clause' ? 404 : 409,
      body: { error: `[${outcome.code}] ${outcome.message}` },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      briefHash: outcome.brief.briefHash,
      text: renderBriefText(outcome.brief, briefHistory(db, target)),
    },
  }
}

/** The /brief page: the SAME text the CLI prints, wrapped in <pre> — one
 * renderer, no second source of truth. */
export const renderBriefPage = (text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>urtext brief</title>
<style>body{font:14px system-ui;margin:2rem;max-width:70rem}pre{background:#f7f7f7;padding:1rem;overflow-x:auto}</style>
</head><body><p><a href="/">← console</a></p><pre>${esc(text)}</pre></body></html>`

export interface DecideResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one adjudication from the UI. Reuses `recordDecision` guards (P2:
 * non-manual clauses rejected; verdict bound to HEAD; a high-risk manual pass
 * additionally requires the current brief-hash — C018). */
export const handleDecide = (
  db: Database,
  root: string,
  input: unknown,
  decider: string
): DecideResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const { key, verdict, briefHash } = input as { key?: unknown; verdict?: unknown; briefHash?: unknown }
  if (typeof key !== 'string' || (verdict !== 'pass' && verdict !== 'fail'))
    return { status: 400, body: { error: 'need { key, verdict: pass|fail }' } }
  if (briefHash !== undefined && typeof briefHash !== 'string')
    return { status: 400, body: { error: 'briefHash must be a string' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const specPath = key.slice(0, hash)
  const clauseId = key.slice(hash + 1)
  const outcome = recordDecision(
    db,
    { specPath, clauseId, verdict, decider, ...(briefHash !== undefined ? { briefHash } : {}) },
    root,
    Date.now()
  )
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}
