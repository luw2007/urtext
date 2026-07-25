/**
 * S2 console renderer (urtext-20260724-ui-redesign §3.1/§5/§6.2). Pure
 * string builder consuming `UiSnapshot` (review-ui.ts's model) — no reads,
 * no writes. Section order is fixed and load-bearing: skip link (pageShell)
 * → header → nav → summary → unmapped banner → Your queue → audit form →
 * Agent lane → All Specs → Decided.
 */
import type { UiClause, UiSnapshot } from '../review-ui.js'
import type { StatusItem } from '../status.js'

import { CONSOLE_SCRIPT } from './console-script.js'
import { briefHref, esc, pageShell, riskBadge, statusChip } from './html.js'

const dirtyChip = (dirty: boolean): string => (dirty ? ` ${statusChip('warn', '⚠', 'worktree dirty')}` : '')

const header = (snapshot: UiSnapshot): string =>
  `<header><h1 id="console-title">urtext console</h1> <code>${esc(snapshot.head?.slice(0, 7) ?? 'n/a')}</code>${dirtyChip(
    snapshot.dirty
  )} <small>Ctrl-C to quit</small></header>`

const nav = (): string =>
  `<nav aria-label="页面导航"><a href="#your-queue-title">Your queue</a> · <a href="#agent-lane-title">Agent lane</a> · <a href="#all-specs">All Specs</a> · <a href="/">刷新状态</a></nav>`

const summary = (snapshot: UiSnapshot): string => {
  const wip = snapshot.status.wip.exceeded
    ? `<p data-banner="wip">warning: human queue ${snapshot.status.counts.human} exceeds wip limit ${snapshot.status.wip.limit} — consider smaller changes</p>`
    : ''
  return `<p>${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided</p>${wip}`
}

const workspaceBanner = (snapshot: UiSnapshot): string => {
  if (snapshot.unmappedError !== null) {
    return `<section role="alert" aria-labelledby="workspace-alert-title" data-banner="unmapped-error"><h2 id="workspace-alert-title">unmapped 检测失败</h2><p><b>unmapped 检测失败：</b>${esc(
      snapshot.unmappedError
    )} — 本页不能证明不存在未归属变更</p></section>`
  }
  if (snapshot.unmapped.length > 0) {
    const items = snapshot.unmapped
      .map((hunk) => {
        const range = `${hunk.filePath}:${hunk.lineStart}-${hunk.lineEnd}`
        return `<li><code>${esc(range)}</code><br><small>映射：<code>urtext map &lt;spec&gt;#&lt;clause&gt; ${esc(
          range
        )}</code><br>确认例外：<code>urtext ack ${esc(range)} &lt;reason&gt;</code><br>或先修改对应 spec，再刷新状态。</small></li>`
      })
      .join('')
    return `<section role="alert" aria-labelledby="workspace-alert-title" data-banner="unmapped"><h2 id="workspace-alert-title">${snapshot.unmapped.length} 个未归属变更（工作区级，git diff HEAD，未跟踪文件不在检测范围）</h2><ul>${items}</ul></section>`
  }
  return ''
}

const queueRow = (item: StatusItem, decideForm: boolean, index: number): string => {
  const risk = item.risk === 'high' ? ` ${riskBadge('high')}` : ''
  const secondary = item.reasons.length > 1 ? ` <small>(+${esc(item.reasons.slice(1).join(', '))})</small>` : ''
  const title = item.title ? ` ${esc(item.title)}` : ''
  let action: string
  if (item.kind === 'unmapped') {
    action = '<small>map / ack / spec write-back via CLI</small>'
  } else {
    const key = `${item.specPath}#${item.clauseId}`
    const brief = `<a href="${esc(briefHref(item.specPath!, item.clauseId!))}">brief</a>`
    if (decideForm && item.reasons.includes('manual_undecided')) {
      action = `${brief} <details><summary>Decide</summary><form class="decide-form" data-key="${esc(
        key
      )}" id="decision-form-${index}"><label for="decision-note-${index}">Reason</label><textarea id="decision-note-${index}" name="note"></textarea><button type="submit" data-v="pass">✓ pass</button><button type="submit" data-v="fail">✗ fail</button></form><output class="decision-msg" aria-live="polite" for="decision-form-${index}"></output></details>`
    } else if (decideForm) {
      action = `${brief} <small>${esc(item.next)}</small>`
    } else {
      action = brief
    }
  }
  return `<tr><td>${esc(item.key)}${title}${risk}</td><td>${esc(item.primary)}${secondary}</td><td>${action}</td></tr>`
}

const queueTable = (id: string, caption: string, rows: string, emptyText: string): string =>
  `<table><caption>${esc(caption)}</caption><thead><tr><th scope="col">条款</th><th scope="col">阻塞原因</th><th scope="col">动作</th></tr></thead><tbody id="${esc(
    id
  )}">${rows || `<tr><td colspan="3">${esc(emptyText)}</td></tr>`}</tbody></table>`

const yourQueueSection = (human: StatusItem[]): string => {
  const rows = human.map((item, index) => queueRow(item, true, index)).join('')
  return `<section aria-labelledby="your-queue-title"><h2 id="your-queue-title">Your queue (${human.length})</h2>${queueTable(
    'your-queue-rows',
    `Your queue (${human.length})`,
    rows,
    'nothing — prerequisites pending or all clear'
  )}</section>`
}

const auditControls = (items: StatusItem[]): string => {
  const auditable = items.filter((item) => item.reasons.includes('unaudited') || item.reasons.includes('audit_disagreement')).length
  if (auditable === 0) return ''
  return `<form id="audit-runner"><label>Audit ${auditable} evidence item(s) with
    <select name="auditor"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option><option value="omp">OMP</option></select></label>
    <input name="model" placeholder="model（可选）"><input name="profile" placeholder="profile（Codex/Traex/OMP）">
    <button type="submit">Run audit</button> <output id="audit-progress" aria-live="polite"></output> <small>D3 preset separation remains your responsibility.</small></form>`
}

const agentLaneSection = (human: StatusItem[], agent: StatusItem[]): string => {
  const hints = [...new Set(agent.map((item) => item.next))]
  const hintList = hints.length > 0 ? `<ul>${hints.map((hint) => `<li>${esc(hint)}</li>`).join('')}</ul>` : ''
  const rows = agent.map((item, index) => queueRow(item, false, index)).join('')
  const open = human.length === 0 ? ' open' : ''
  return `<details data-section="agent-lane"${open}><summary id="agent-lane-title">Agent lane (${agent.length})</summary>${hintList}${queueTable(
    'agent-lane-rows',
    `Agent lane (${agent.length})`,
    rows,
    'empty'
  )}</details>`
}

const evidenceCell = (clause: UiClause): string => {
  const primary =
    clause.evidenceVerdict === 'pass'
      ? statusChip('ok', '✓', 'pass', 'fresh')
      : clause.evidenceVerdict === 'fail'
        ? statusChip('danger', '✗', 'fail')
        : clause.evidenceVerdict === 'pending'
          ? statusChip('warn', '●', 'pending')
          : statusChip('muted', '○', 'no evidence', 'no-evidence')
  const stale = clause.stale ? ` ${statusChip('warn', '⚠', 'stale', 'stale')}` : ''
  return `${primary}${stale}`
}

const clauseRow = (clause: UiClause): string => {
  const key = `${clause.specPath}#${clause.clauseId}`
  return `<tr data-clause="${esc(key)}"><td><a href="${esc(briefHref(clause.specPath, clause.clauseId))}">${esc(
    clause.clauseId
  )}</a> ${esc(clause.title)}</td><td>${riskBadge(clause.risk)}</td><td>${evidenceCell(clause)}</td></tr>`
}

const allSpecsSection = (clauses: UiClause[]): string => {
  const groups = new Map<string, UiClause[]>()
  for (const clause of clauses) {
    const list = groups.get(clause.specPath) ?? []
    list.push(clause)
    groups.set(clause.specPath, list)
  }
  const body =
    groups.size === 0
      ? '<p>no live clauses</p>'
      : [...groups.entries()]
          .map(([specPath, group], index) => {
            const title = `<code>${esc(specPath)}</code> (${group.length})`
            return `<section aria-labelledby="spec-group-${index}-title"><h3 id="spec-group-${index}-title">${title}</h3><table><caption>${title}</caption><thead><tr><th scope="col">Clause</th><th scope="col">Risk</th><th scope="col">Evidence</th></tr></thead><tbody>${group
              .map(clauseRow)
              .join('')}</tbody></table></section>`
          })
          .join('')
  return `<section id="all-specs" aria-labelledby="all-specs-title"><h2 id="all-specs-title">All Specs (${clauses.length})</h2>${body}</section>`
}

const decidedRow = (clause: UiClause): string => {
  const state = clause.decisionVerdict === 'pass' ? statusChip('ok', '✓', 'pass') : statusChip('danger', '✗', 'fail')
  return `<tr><td>${esc(`${clause.specPath}#${clause.clauseId}`)} ${esc(clause.title)}</td><td>${state}</td><td><a href="${esc(
    briefHref(clause.specPath, clause.clauseId)
  )}">brief</a></td></tr>`
}

const decidedSection = (snapshot: UiSnapshot): string => {
  const decided = snapshot.clauses.filter((c) => c.decisionVerdict === 'pass' || c.decisionVerdict === 'fail')
  const rows = decided.map(decidedRow).join('')
  return `<section aria-labelledby="decided-title"><h2 id="decided-title">Decided manual clauses at HEAD (${
    decided.length
  })</h2><table><caption>Decided manual clauses at HEAD (${decided.length})</caption><thead><tr><th scope="col">条款</th><th scope="col">Verdict</th><th scope="col">Brief</th></tr></thead><tbody>${
    rows || '<tr><td colspan="3">none yet</td></tr>'
  }</tbody></table></section>`
}

/** Render the self-contained S2 console page. */
export const renderConsolePage = (snapshot: UiSnapshot, csrfToken: string, auditResult?: string): string => {
  const human = snapshot.status.items.filter((item) => item.lane === 'human')
  const agent = snapshot.status.items.filter((item) => item.lane === 'agent')
  const notice = auditResult !== undefined ? `<p id="audit-result">${esc(auditResult)}</p>` : ''
  const main = `<main id="main">${summary(snapshot)}${workspaceBanner(snapshot)}${notice}${yourQueueSection(human)}${auditControls(
    snapshot.status.items
  )}${agentLaneSection(human, agent)}${allSpecsSection(snapshot.clauses)}${decidedSection(snapshot)}</main>`
  return pageShell({
    title: 'urtext console',
    csrfToken,
    header: header(snapshot),
    nav: nav(),
    main,
    script: CONSOLE_SCRIPT,
  })
}
