/**
 * Server-rendered console-family pages. Domain truth stays in UiSnapshot;
 * route selection and pagination are renderer-only projections.
 */
import type { UiClause, UiSnapshot } from '../review-ui.js'
import type { StatusItem } from '../status.js'

import { CONSOLE_SCRIPT } from './console-script.js'
import { approvalSemantics, briefHref, esc, pageShell, riskBadge, statusChip } from './html.js'
import { DEFAULT_PAGE_SIZE, pageHref, pageWindow, paginationNav, type PageWindow } from './pagination.js'

export type ConsoleRoute = 'queue' | 'agent' | 'specs' | 'decisions'

export interface ConsolePageInput {
  route: ConsoleRoute
  snapshot: UiSnapshot
  csrfToken: string
  page: number
  pageSize: number
  auditResult?: string
}

const ROUTE_PATH: Record<ConsoleRoute, string> = {
  queue: '/',
  agent: '/agent',
  specs: '/specs',
  decisions: '/decisions',
}

const ROUTE_TITLE: Record<ConsoleRoute, string> = {
  queue: 'Your queue',
  agent: 'Agent lane',
  specs: 'All Specs',
  decisions: 'Decided manual clauses at HEAD',
}

const dirtyChip = (dirty: boolean): string => (dirty ? ` ${statusChip('warn', '⚠', 'worktree dirty')}` : '')

const header = (snapshot: UiSnapshot): string =>
  `<header><h1 id="console-title">urtext console</h1> <code>${esc(snapshot.head?.slice(0, 7) ?? 'n/a')}</code>${dirtyChip(
    snapshot.dirty
  )} <small>Ctrl-C to quit</small></header>`

const appNav = (route: ConsoleRoute, page: number): string => {
  const link = (target: ConsoleRoute, label: string): string =>
    `<a href="${ROUTE_PATH[target]}"${target === route ? ' aria-current="page"' : ''}>${label}</a>`
  return `<nav aria-label="页面导航">${link('queue', 'Your queue')} · ${link('agent', 'Agent lane')} · ${link(
    'specs',
    'All Specs'
  )} · ${link('decisions', 'Decided')} · <a href="${esc(pageHref(ROUTE_PATH[route], page))}">刷新状态</a></nav>`
}

const summary = (snapshot: UiSnapshot): string => {
  const wip = snapshot.status.wip.exceeded
    ? `<p data-banner="wip">warning: human queue ${snapshot.status.counts.human} exceeds wip limit ${snapshot.status.wip.limit} — consider smaller changes</p>`
    : ''
  return `<p>${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided</p>${wip}`
}

const uncoveredIntentSection = (snapshot: UiSnapshot): string => {
  const requirements = snapshot.status.uncoveredRequirements
  const content =
    requirements.length === 0
      ? `<p>${statusChip('muted', '○', '无未覆盖意图', 'uncovered-none')} — every live requirement has a unique clause binding</p>`
      : `<ul>${requirements
          .map((requirement) => {
            const key = `${requirement.specPath}#${requirement.reqId}`
            return `<li data-uncovered="${esc(key)}">${statusChip(
              'warn',
              '⚠',
              '未覆盖',
              'uncovered'
            )} <code>${esc(key)}</code> ${esc(requirement.title)}</li>`
          })
          .join('')}</ul>`
  return `<section id="uncovered-intent" aria-labelledby="uncovered-intent-title"><h2 id="uncovered-intent-title">Uncovered intent (${requirements.length})</h2>${content}<p><small>意图缺锁不是阻断项：不进队列、不计入 wip、不改变退出码。</small></p></section>`
}

const FEATURE_PATH = /^specs\/([^/]+)\//

const featureOf = (specPath: string): string => specPath.match(FEATURE_PATH)?.[1] ?? specPath

interface FeatureHealthRow {
  feature: string
  total: number
  evidencePass: number
  evidenceTotal: number
  auditAgree: number
  auditTotal: number
  highRiskApproved: number
  highRiskTotal: number
  uncovered: number
}

/** P2 is intentionally renderer-owned: fixtures provide raw clause facts. */
const featureHealthRows = (snapshot: UiSnapshot): FeatureHealthRow[] => {
  const rows = new Map<string, FeatureHealthRow>()
  const rowFor = (specPath: string): FeatureHealthRow => {
    const feature = featureOf(specPath)
    const current = rows.get(feature)
    if (current !== undefined) return current
    const created: FeatureHealthRow = {
      feature,
      total: 0,
      evidencePass: 0,
      evidenceTotal: 0,
      auditAgree: 0,
      auditTotal: 0,
      highRiskApproved: 0,
      highRiskTotal: 0,
      uncovered: 0,
    }
    rows.set(feature, created)
    return created
  }
  for (const clause of snapshot.clauses) {
    const row = rowFor(clause.specPath)
    row.total += 1
    if (clause.decisionVerdict === 'n/a' && !clause.stale) {
      row.evidenceTotal += 1
      row.auditTotal += 1
      if (clause.evidenceVerdict === 'pass') row.evidencePass += 1
      if (clause.auditVerdict === 'agree') row.auditAgree += 1
    }
    if (clause.risk === 'high') {
      row.highRiskTotal += 1
      if (
        clause.reviewStatus === 'approved' &&
        !snapshot.dirty &&
        !clause.stale &&
        (clause.decisionVerdict !== 'n/a' ||
          (clause.evidenceVerdict === 'pass' && clause.auditVerdict === 'agree'))
      ) {
        row.highRiskApproved += 1
      }
    }
  }
  for (const requirement of snapshot.status.uncoveredRequirements) {
    rowFor(requirement.specPath).uncovered += 1
  }
  return [...rows.values()].sort((left, right) => left.feature.localeCompare(right.feature))
}

const healthCell = (label: string, numerator: number, denominator: number): string => {
  if (denominator === 0) {
    return `${esc(label)} ${statusChip('muted', '—', `n/a (${numerator}/${denominator})`, 'health-unavailable')}`
  }
  const complete = numerator === denominator
  return `${esc(label)} ${statusChip(
    complete ? 'ok' : 'warn',
    complete ? '✓' : '⚠',
    `${numerator}/${denominator}`,
    complete ? 'health-complete' : 'health-incomplete'
  )}`
}

const featureHealthSection = (snapshot: UiSnapshot): string => {
  const rows = featureHealthRows(snapshot)
  const body =
    rows.length === 0
      ? `<p data-state="feature-health-empty">${statusChip('muted', '○', '暂无活跃条款')}</p>`
      : `<ul id="feature-health">${rows
          .map(
            (row) =>
              `<li data-feature="${esc(row.feature)}"><a href="/specs">${esc(row.feature)}</a> <small>(${row.total} 条)</small> ${healthCell(
                '证据',
                row.evidencePass,
                row.evidenceTotal
              )} ${healthCell('元审计', row.auditAgree, row.auditTotal)} ${healthCell(
                '高危已批准',
                row.highRiskApproved,
                row.highRiskTotal
              )} 未覆盖意图 ${
                row.uncovered === 0
                  ? statusChip('ok', '✓', '0', 'health-uncovered-none')
                  : statusChip('warn', '⚠', String(row.uncovered), 'health-uncovered')
              }</li>`
          )
          .join('')}</ul>`
  return `<section id="feature-health-section" aria-labelledby="feature-health-title"><h2 id="feature-health-title">Feature health (${rows.length})</h2>${body}<p><small>只读投影：不进入队列、WIP 或退出码。</small></p></section>`
}

const explainControls = (): string =>
  `<section id="queue-explain" aria-labelledby="queue-explain-title">
<h2 id="queue-explain-title">AI 解释</h2>
<label for="queue-explain-auditor">客户端</label>
<select id="queue-explain-auditor"><option value="omp" selected>OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option></select>
<label for="queue-explain-model">模型</label>
<input id="queue-explain-model" value="deepseek/deepseek-v4-flash">
<button type="button" id="queue-explain-btn" aria-controls="queue-explain-out">AI 总结当前队列</button>
<output id="queue-explain-out" aria-live="polite"></output>
<p><small>只读：解释不写任何账本；每条待办右侧也有单项解释入口。</small></p>
</section>`

const workspaceAlert = (snapshot: UiSnapshot, route: ConsoleRoute): string => {
  if (snapshot.unmappedError !== null) {
    const action = route === 'queue' ? '' : ' — <a href="/">在 Your queue 查看</a>'
    return `<p role="alert" data-banner="unmapped-error">⚠ unmapped 检测失败：${esc(
      snapshot.unmappedError
    )} — 本页不能证明不存在未归属变更${action}</p>`
  }
  if (snapshot.unmapped.length > 0) {
    const action = route === 'queue' ? '— 详见下方 Your queue 行' : '— <a href="/">在 Your queue 处理</a>'
    return `<p role="alert" data-banner="unmapped">⚠ ${snapshot.unmapped.length} 个未归属变更（工作区级，git diff HEAD，未跟踪文件不在检测范围）${action}</p>`
  }
  return ''
}

const caption = (route: ConsoleRoute, w: PageWindow): string =>
  `${ROUTE_TITLE[route]} (共 ${w.total} 条 · 第 ${w.page}/${w.pageCount} 页)`

const causalLine = (item: StatusItem): string => {
  if (!item.reasons.includes('stale')) return ''
  const culprit =
    item.invalidationSource === undefined
      ? '上游变更'
      : `<code>${esc(item.invalidationSource)}</code> 文本变更`
  return `<p data-causal="${esc(item.key)}">${statusChip('warn', '⚠', '因果链', 'causal')} ${culprit} → <code>${esc(
    item.key
  )}</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行</p>`
}

interface QueueRowOptions {
  decideForm: boolean
  explainForItem: boolean
  head: string | null
}

const itemExplainControl = (item: StatusItem, index: number): string =>
  ` <button type="button" id="explain-item-btn-${index}" aria-controls="explain-item-out-${index}" data-explain-key="${esc(
    item.key
  )}">AI 解释</button> <output id="explain-item-out-${index}" aria-live="polite"></output>`

const queueRow = (item: StatusItem, options: QueueRowOptions, index: number): string => {
  const risk = item.risk === 'high' ? ` ${riskBadge('high')}` : ''
  const secondary = item.reasons.length > 1 ? ` <small>(+${esc(item.reasons.slice(1).join(', '))})</small>` : ''
  const title = item.title ? ` ${esc(item.title)}` : ''
  let action: string
  if (item.kind === 'unmapped') {
    const range = esc(item.key)
    action = `<small>映射：<code>urtext map &lt;spec&gt;#&lt;clause&gt; ${range}</code><br>确认例外：<code>urtext ack ${range} &lt;reason&gt;</code><br>或先修改对应 spec，再刷新状态。</small>${
      options.explainForItem ? itemExplainControl(item, index) : ''
    }`
  } else {
    const key = `${item.specPath}#${item.clauseId}`
    const brief = `<a href="${esc(briefHref(item.specPath!, item.clauseId!))}">brief</a>`
    if (options.decideForm && item.reasons.includes('manual_undecided')) {
      action = `${brief} <details><summary>Decide</summary><form class="decide-form" data-key="${esc(
        key
      )}" id="decision-form-${index}"><label for="decision-note-${index}">Reason</label><textarea id="decision-note-${index}" name="note"></textarea><p data-state="approval-semantics"><small>${esc(
        approvalSemantics(options.head)
      )}</small></p><button type="submit" data-v="pass">✓ pass</button><button type="submit" data-v="fail">✗ fail</button></form><output class="decision-msg" aria-live="polite" for="decision-form-${index}"></output></details>`
    } else if (options.decideForm) {
      action = `${brief} <small>${esc(item.next)}</small>`
    } else {
      action = brief
    }
    if (options.explainForItem) action += itemExplainControl(item, index)
  }
  return `<tr data-row="${esc(item.key)}"><td>${esc(item.key)}${title}${risk}</td><td>${esc(
    item.primary
  )}${secondary}${causalLine(item)}</td><td>${action}</td></tr>`
}

const queueTable = (id: string, tableCaption: string, rows: string, emptyText: string): string =>
  `<table><caption>${esc(tableCaption)}</caption><thead><tr><th scope="col">条款</th><th scope="col">阻塞原因</th><th scope="col">动作</th></tr></thead><tbody id="${esc(
    id
  )}">${rows || `<tr><td colspan="3">${esc(emptyText)}</td></tr>`}</tbody></table>`

const queueSection = (items: readonly StatusItem[], w: PageWindow, head: string | null): string => {
  const rows = items
    .map((item, index) => queueRow(item, { decideForm: true, explainForItem: true, head }, index))
    .join('')
  return `<section aria-labelledby="your-queue-title"><h2 id="your-queue-title">Your queue (${w.total})</h2>${queueTable(
    'your-queue-rows',
    caption('queue', w),
    rows,
    'nothing — prerequisites pending or all clear'
  )}</section>`
}

const auditControls = (items: readonly StatusItem[]): string => {
  const auditable = items.filter((item) => item.reasons.includes('unaudited') || item.reasons.includes('audit_disagreement')).length
  const disabled = auditable === 0 ? ' disabled' : ''
  const empty = auditable === 0 ? '<p>当前没有待审计的证据</p>' : ''
  return `<form id="audit-runner"><label>Audit ${auditable} evidence item(s) with
    <select name="auditor"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option><option value="omp">OMP</option></select></label>
    <input name="model" placeholder="model（可选）"><input name="profile" placeholder="profile（Codex/Traex/OMP）">
    <button type="submit"${disabled}>Run audit</button> <output id="audit-progress" aria-live="polite"></output> ${empty}<small>D3 preset separation remains your responsibility.</small></form>`
}

const agentSection = (pageItems: readonly StatusItem[], all: readonly StatusItem[], w: PageWindow): string => {
  const hints = [...new Set(pageItems.map((item) => item.next))]
  const hintList = hints.length > 0 ? `<ul>${hints.map((hint) => `<li>${esc(hint)}</li>`).join('')}</ul>` : ''
  const rows = pageItems
    .map((item, index) =>
      queueRow(item, { decideForm: false, explainForItem: false, head: null }, index)
    )
    .join('')
  return `${auditControls(all)}<section aria-labelledby="agent-lane-title"><h2 id="agent-lane-title">Agent lane (${w.total})</h2>${hintList}${queueTable(
    'agent-lane-rows',
    caption('agent', w),
    rows,
    'empty'
  )}</section>`
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

const specsSection = (pageClauses: readonly UiClause[], w: PageWindow): string => {
  if (w.total === 0) {
    return '<section id="all-specs" aria-labelledby="all-specs-title"><h2 id="all-specs-title">All Specs (0)</h2><p>no live clauses</p></section>'
  }
  const groups: { specPath: string; clauses: UiClause[] }[] = []
  for (const clause of pageClauses) {
    const current = groups.at(-1)
    if (current?.specPath === clause.specPath) current.clauses.push(clause)
    else groups.push({ specPath: clause.specPath, clauses: [clause] })
  }
  const bodies = groups
    .map(
      ({ specPath, clauses }) =>
        `<tbody data-spec="${esc(specPath)}"><tr><th colspan="3" scope="rowgroup"><code>${esc(specPath)}</code> (本页 ${clauses.length})</th></tr>${clauses
          .map(clauseRow)
          .join('')}</tbody>`
    )
    .join('')
  return `<section id="all-specs" aria-labelledby="all-specs-title"><h2 id="all-specs-title">All Specs (${w.total})</h2><table><caption>${esc(
    caption('specs', w)
  )}</caption><thead><tr><th scope="col">Clause</th><th scope="col">Risk</th><th scope="col">Evidence</th></tr></thead>${bodies}</table></section>`
}

const decidedRow = (clause: UiClause): string => {
  const key = `${clause.specPath}#${clause.clauseId}`
  const state = clause.decisionVerdict === 'pass' ? statusChip('ok', '✓', 'pass') : statusChip('danger', '✗', 'fail')
  return `<tr data-row="${esc(key)}"><td>${esc(key)} ${esc(clause.title)}</td><td>${state}</td><td><a href="${esc(
    briefHref(clause.specPath, clause.clauseId)
  )}">brief</a></td></tr>`
}

const decidedSection = (pageClauses: readonly UiClause[], w: PageWindow): string => {
  const rows = pageClauses.map(decidedRow).join('')
  return `<section aria-labelledby="decided-title"><h2 id="decided-title">Decided manual clauses at HEAD (${w.total})</h2><table><caption>${esc(
    caption('decisions', w)
  )}</caption><thead><tr><th scope="col">条款</th><th scope="col">Verdict</th><th scope="col">Brief</th></tr></thead><tbody>${
    rows || '<tr><td colspan="3">none yet</td></tr>'
  }</tbody></table></section>`
}

export const renderConsoleFamilyPage = (input: ConsolePageInput): string => {
  const { route, snapshot } = input
  const interactive = route === 'queue' || route === 'agent'
  const win = (total: number): PageWindow => pageWindow(total, input.page, input.pageSize)
  let w: PageWindow
  let body: string
  if (route === 'queue') {
    const items = snapshot.status.items.filter((item) => item.lane === 'human')
    w = win(items.length)
    body = queueSection(items.slice(w.start, w.end), w, snapshot.head)
  } else if (route === 'agent') {
    const items = snapshot.status.items.filter((item) => item.lane === 'agent')
    w = win(items.length)
    body = agentSection(items.slice(w.start, w.end), snapshot.status.items, w)
  } else if (route === 'specs') {
    w = win(snapshot.clauses.length)
    body = specsSection(snapshot.clauses.slice(w.start, w.end), w)
  } else {
    const clauses = snapshot.clauses.filter((clause) => clause.decisionVerdict === 'pass' || clause.decisionVerdict === 'fail')
    w = win(clauses.length)
    body = decidedSection(clauses.slice(w.start, w.end), w)
  }
  const notice = input.auditResult !== undefined ? `<p id="audit-result">${esc(input.auditResult)}</p>` : ''
  const main = `<main id="main">${route === 'queue' ? summary(snapshot) : ''}${workspaceAlert(
    snapshot,
    route
  )}${route === 'queue' ? featureHealthSection(snapshot) : ''}${
    route === 'queue' ? explainControls() : ''
  }${notice}${body}${paginationNav(ROUTE_PATH[route], w)}${
    route === 'queue' ? uncoveredIntentSection(snapshot) : ''
  }</main>`
  return pageShell({
    title: 'urtext console',
    ...(interactive ? { csrfToken: input.csrfToken } : {}),
    header: header(snapshot),
    nav: appNav(route, w.page),
    main,
    ...(interactive ? { script: CONSOLE_SCRIPT } : {}),
  })
}

/** Frozen public API: the root route at default page size. */
export const renderConsolePage = (snapshot: UiSnapshot, csrfToken: string, auditResult?: string): string =>
  renderConsoleFamilyPage({
    route: 'queue',
    snapshot,
    csrfToken,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    ...(auditResult !== undefined ? { auditResult } : {}),
  })
