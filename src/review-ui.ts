/**
 * Review UI core (pure logic) — the model and rendering behind `urtext ui`.
 *
 * Adjudication truth comes from `adjudicate` (gate.ts), which merges the Decision
 * ledger: a `manual` clause with a `pass`/`fail` decision at the current HEAD
 * shows that verdict; one still undecided is `actionable` (buttons rendered).
 * Writes go through `recordDecision` (decision.ts) — the same guarded path as the
 * `urtext decide` CLI, so the UI never becomes a second source of truth (C104, P2).
 */
import type { Database } from 'better-sqlite3'

import { adjudicate } from './gate.js'
import { currentHead, recordDecision } from './decision.js'

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
  clauses: UiClause[]
  /** Manual clauses decided at HEAD / total manual clauses. */
  decided: number
  totalManual: number
}

/** Build the review model from the gate's adjudication (Decision-ledger-aware). */
export const buildUiSnapshot = (db: Database, root: string): UiSnapshot => {
  const head = currentHead(root)
  const report = adjudicate(db, 0, head ?? undefined)
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
    clauses,
    decided: manual.filter((c) => c.decisionVerdict === 'pass' || c.decisionVerdict === 'fail').length,
    totalManual: manual.length,
  }
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]!)

/** Render the self-contained review page. No inline handlers; a delegated
 * listener reads `data-*` and posts with the session CSRF token. */
export const renderPage = (snapshot: UiSnapshot, csrfToken: string): string => {
  const rows = snapshot.clauses
    .filter((c) => c.decisionVerdict !== 'n/a')
    .map((c) => {
      const key = `${c.specPath}#${c.clauseId}`
      const risk = c.risk === 'high' ? ' <span style="color:#c00">[high]</span>' : ''
      const state =
        c.decisionVerdict === 'pass'
          ? '<b style="color:#0a0">✓ pass</b>'
          : c.decisionVerdict === 'fail'
            ? '<b style="color:#c00">✗ fail</b>'
            : '<b style="color:#b80">pending</b>'
      const btns = c.actionable
        ? `<button data-key="${esc(key)}" data-v="pass">✓ pass</button>` +
          `<button data-key="${esc(key)}" data-v="fail">✗ fail</button>`
        : ''
      return `<tr><td>${esc(c.clauseId)}${risk}</td><td>${esc(c.title)}</td><td>${state}</td><td>${btns}</td></tr>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="csrf" content="${esc(csrfToken)}">
<title>urtext review</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}
table{border-collapse:collapse;width:100%}td{padding:.4rem .6rem;border-bottom:1px solid #eee}
button{margin-right:.3rem;cursor:pointer}</style></head><body>
<h2>urtext manual review <small style="color:#999">· Ctrl-C to quit</small></h2>
<p>${snapshot.decided}/${snapshot.totalManual} manual clauses decided at HEAD ${esc(snapshot.head?.slice(0, 7) ?? 'n/a')}</p>
<table>${rows}</table>
<script>
const csrf = document.querySelector('meta[name=csrf]').content
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-key]'); if (!b) return
  const r = await fetch('/api/decide', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf': csrf },
    body: JSON.stringify({ key: b.dataset.key, verdict: b.dataset.v }) })
  const j = await r.json(); if (j.error) { alert(j.error); return }
  location.reload()
})
</script></body></html>`
}

export interface DecideResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one adjudication from the UI. Reuses `recordDecision` guards (P2:
 * non-manual clauses rejected; verdict bound to HEAD). */
export const handleDecide = (
  db: Database,
  root: string,
  input: unknown,
  decider: string
): DecideResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const { key, verdict } = input as { key?: unknown; verdict?: unknown }
  if (typeof key !== 'string' || (verdict !== 'pass' && verdict !== 'fail'))
    return { status: 400, body: { error: 'need { key, verdict: pass|fail }' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const specPath = key.slice(0, hash)
  const clauseId = key.slice(hash + 1)
  const outcome = recordDecision(db, { specPath, clauseId, verdict, decider }, root, Date.now())
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}
