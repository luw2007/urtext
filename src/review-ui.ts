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
 * here). High-risk CODE review is also available from the browser: the /brief
 * page shows the mapped code and, when the clause is review-ready, approve/reject
 * buttons that post to the SAME guarded `recordReview` path (P5 preconditions —
 * high-risk only, clean worktree, current brief-hash, HEAD binding — live in
 * review.ts, not here, so the browser cannot bypass them).
 */
import type { Database } from 'better-sqlite3'

import { runAgentText, runAuditAgentAsync, type AuditorId } from './audit-runner.js'
import { coverage, exportRequest, importVerdicts } from './audit.js'
import { buildBrief, renderBriefText, type BriefHistoryLine, type ClauseTarget } from './brief.js'
import { detectUnmapped } from './dwarf.js'
import { adjudicate } from './gate.js'
import { buildStatus, type StatusItem, type StatusReport } from './status.js'
import { currentHead, listDecisions, recordDecision } from './decision.js'
import { listReviews, recordReview, worktreeDirty } from './review.js'

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

const auditControls = (items: StatusItem[]): string => {
  const auditable = items.filter((item) => item.reasons.includes('unaudited') || item.reasons.includes('audit_disagreement')).length
  if (auditable === 0) return ''
  return `<form id="audit-runner"><label>Audit ${auditable} evidence item(s) with
    <select name="auditor"><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option><option value="omp">OMP</option></select></label>
    <input name="model" placeholder="model（可选）"><input name="profile" placeholder="profile（Codex/Traex/OMP）">
    <button type="submit">Run audit</button> <output id="audit-progress" aria-live="polite"></output> <small>D3 preset separation remains your responsibility.</small></form>`
}

/** Render the self-contained console page. No inline handlers; a delegated
 * listener reads `data-*`, fetches the brief-hash, and posts with the session
 * CSRF token. */
export const renderPage = (snapshot: UiSnapshot, csrfToken: string, auditResult?: string): string => {
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
  const notice = auditResult ? `<p id="audit-result" style="color:#075">${esc(auditResult)}</p>` : ''
  const audit = auditControls(snapshot.status.items)
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="csrf" content="${esc(csrfToken)}">
<title>urtext console</title>
<style>body{font:14px system-ui;margin:2rem;max-width:70rem}
table{border-collapse:collapse;width:100%;margin-bottom:1.2rem}td{padding:.4rem .6rem;border-bottom:1px solid #eee}
h3{margin:.4rem 0}button{margin-left:.3rem;cursor:pointer}</style></head><body>
<h2>urtext console <small style="color:#999">· Ctrl-C to quit</small></h2>
<p>HEAD ${esc(snapshot.head?.slice(0, 7) ?? 'n/a')}${dirty} — ${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided</p>
${wip}
${notice}
<h3>Your queue (${human.length})</h3>
<table>${humanRows || '<tr><td>nothing — prerequisites pending or all clear</td></tr>'}</table>
<h3>Agent lane (${agent.length})</h3>
${audit}<table>${agentRows || '<tr><td>empty</td></tr>'}</table>
<h3>Decided manual clauses at HEAD (${decidedRows ? snapshot.decided : 0})</h3>
<table>${decidedRows || '<tr><td>none yet</td></tr>'}</table>
<script>
const csrf = document.querySelector('meta[name=csrf]').content
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-key]'); if (!b) return
  const key = b.dataset.key
  const note = prompt(b.dataset.v === 'pass' ? 'One-sentence reason (required to pass):' : 'Reason (optional):')
  if (note === null) return
  if (b.dataset.v === 'pass' && !note.trim()) { alert('a one-sentence reason is required to pass'); return }
  const cut = key.lastIndexOf('#')
  const qs = 'spec=' + encodeURIComponent(key.slice(0, cut)) + '&clause=' + encodeURIComponent(key.slice(cut + 1))
  const br = await fetch('/api/brief?' + qs)
  const bj = await br.json()
  if (bj.error) { alert(bj.error); return }
  const r = await fetch('/api/decide', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf': csrf },
    body: JSON.stringify({ key, verdict: b.dataset.v, briefHash: bj.briefHash, ...(note.trim() ? { note: note.trim() } : {}) }) })
  const j = await r.json(); if (j.error) { alert(j.error); return }
  location.reload()
})
document.getElementById('audit-runner')?.addEventListener('submit', async (e) => {
  e.preventDefault(); const form = e.currentTarget; const button = form.querySelector('button'); const progress = document.getElementById('audit-progress')
  button.disabled = true; progress.textContent = 'Running audit; large batches on slow models can take many minutes…'
  const fields = new FormData(form)
  try {
    const r = await fetch('/api/audit-run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ auditor: fields.get('auditor'), model: fields.get('model'), profile: fields.get('profile') }) })
    const j = await r.json(); if (j.error) { progress.textContent = j.error; button.disabled = false; return }
    progress.textContent = j.message + ' Refreshing queue…'; location.href = '/?audit=' + encodeURIComponent(j.message)
  } catch { progress.textContent = 'Audit request failed; no verdicts were imported.'; button.disabled = false }
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

export interface ReviewFacts {
  title: string
  files: string[]
  dependents: number
}

export interface BriefApiResult {
  status: number
  body:
    | { ok: true; briefHash: string; text: string; risk: 'low' | 'high'; reviewable: boolean; facts: ReviewFacts }
    | { error: string }
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
  const manifest = outcome.brief.manifest
  const reviewable =
    manifest.risk === 'high' &&
    manifest.evidence?.verdict === 'pass' &&
    manifest.auditVerdict === 'agree' &&
    !manifest.stale
  const files = [...new Set(manifest.mappings.map((m) => m.filePath))]
  return {
    status: 200,
    body: {
      ok: true,
      briefHash: outcome.brief.briefHash,
      text: renderBriefText(outcome.brief, briefHistory(db, target)),
      risk: manifest.risk,
      reviewable,
      facts: {
        title: `${manifest.specPath}#${manifest.clauseId} ${manifest.title}`,
        files,
        dependents: outcome.brief.impact.affectedClauses.length,
      },
    },
  }
}

export interface ReviewApiResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one high-risk code review from the /brief page. Reuses recordReview's
 * fail-closed guards (unsafe lane P5): high-risk only, clean worktree, current
 * brief-hash, HEAD binding. Approving requires a one-sentence reason — the same
 * anti-rubber-stamp rule as manual pass; rejecting is conservative. */
export const handleReview = (db: Database, root: string, input: unknown, reviewer: string): ReviewApiResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const key = 'key' in input ? input.key : undefined
  const decision = 'decision' in input ? input.decision : undefined
  const briefHash = 'briefHash' in input ? input.briefHash : undefined
  const note = 'note' in input ? input.note : undefined
  if (typeof key !== 'string' || (decision !== 'approve' && decision !== 'reject'))
    return { status: 400, body: { error: 'need { key, decision: approve|reject }' } }
  if (briefHash !== undefined && typeof briefHash !== 'string')
    return { status: 400, body: { error: 'briefHash must be a string' } }
  if (note !== undefined && typeof note !== 'string')
    return { status: 400, body: { error: 'note must be a string' } }
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (decision === 'approve' && trimmedNote === '')
    return { status: 400, body: { error: 'a one-sentence reason (note) is required to approve' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const outcome = recordReview(
    db,
    {
      specPath: key.slice(0, hash),
      clauseId: key.slice(hash + 1),
      decision,
      reviewer,
      ...(trimmedNote ? { note: trimmedNote } : {}),
      ...(briefHash !== undefined ? { briefHash } : {}),
    },
    root,
    Date.now()
  )
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}

export interface ExplainApiResult {
  status: number
  body: { ok: true; text: string } | { error: string }
}

const parseAuditorId = (value: unknown): AuditorId | null =>
  value === 'claude' || value === 'codex' || value === 'traex' || value === 'omp' ? value : null

/** On-demand, per-clause explanation of what approving vs rejecting THIS clause
 * means — generated live by a selected headless client from the clause's own
 * brief (title, body, mapped code, evidence, impact), not a hard-coded template.
 * Read-only: no ledger write, no tools; the model only explains consequences. */
export const handleExplain = async (db: Database, root: string, input: unknown): Promise<ExplainApiResult> => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const key = 'key' in input ? input.key : undefined
  const auditor = parseAuditorId('auditor' in input ? input.auditor : undefined)
  const model = 'model' in input ? input.model : undefined
  if (typeof key !== 'string' || key.lastIndexOf('#') <= 0 || auditor === null)
    return { status: 400, body: { error: 'need { key, auditor: claude|codex|traex|omp }' } }
  if (model !== undefined && typeof model !== 'string')
    return { status: 400, body: { error: 'model must be a string' } }
  const hash = key.lastIndexOf('#')
  const outcome = buildBrief(db, root, { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) })
  if (outcome.kind === 'refused') return { status: 409, body: { error: outcome.message } }
  const prompt = [
    '你是 Urtext 的资深审查助手。下面是一个高风险条款的完整裁决简报（条文、映射代码、证据、影响闭包）。',
    '用中文，基于这个条款的具体内容，向人类审查者说明：',
    '1. 如果批准（approve）这条，对系统有什么实际影响——结合该条款真实约束和它保护的代码路径，举一个具体、可能发生的场景；',
    '2. 如果拒绝（reject）这条，会怎样，以及在什么情况下应该拒绝——同样给一个具体例子；',
    '3. 一句话给出你的倾向和理由。',
    '不要泛泛而谈或复述通用流程；紧扣本条款的语义与代码。不要执行任何命令或修改文件，只解释。',
    '',
    renderBriefText(outcome.brief, briefHistory(db, { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) })),
  ].join('\n')
  const result = await runAgentText(prompt, { id: auditor, ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}) })
  return result.kind === 'completed' && result.text !== undefined
    ? { status: 200, body: { ok: true, text: result.text } }
    : { status: 422, body: { error: result.message ?? 'agent failed' } }
}

export interface AuditRunResult {
  status: number
  body: { ok: true; message: string } | { error: string }
}

export const handleAuditRun = async (db: Database, input: unknown): Promise<AuditRunResult> => {
  if (typeof input !== 'object' || input === null || !('auditor' in input)) {
    return { status: 400, body: { error: 'need auditor: claude, codex, traex, or omp' } }
  }
  const auditor = input.auditor
  const model = 'model' in input ? input.model : undefined
  const profile = 'profile' in input ? input.profile : undefined
  if ((auditor !== 'claude' && auditor !== 'codex' && auditor !== 'traex' && auditor !== 'omp') ||
      (model !== undefined && typeof model !== 'string') || (profile !== undefined && typeof profile !== 'string') ||
      (auditor === 'claude' && profile !== undefined && profile !== '')) {
    return { status: 400, body: { error: 'invalid auditor, model, or profile' } }
  }
  const result = await runAuditAgentAsync(exportRequest(db), {
    id: auditor,
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(typeof profile === 'string' && profile.trim() ? { profile: profile.trim() } : {}),
  })
  if (result.kind === 'rejected') return { status: 422, body: { error: result.message ?? 'audit runner rejected' } }
  if (result.verdicts === undefined || result.verdicts.length === 0) {
    return { status: 200, body: { ok: true, message: 'No decided, current evidence to audit.' } }
  }
  const outcome = importVerdicts(db, result.verdicts, Date.now())
  if (outcome.kind === 'rejected') return { status: 422, body: { error: outcome.message } }
  const report = coverage(db)
  return {
    status: 200,
    body: {
      ok: true,
      message: report.counts.disagree > 0
        ? `imported ${outcome.count} verdict(s); ${report.counts.disagree} disagreement(s) moved to Your queue.`
        : `imported ${outcome.count} verdict(s)`,
    },
  }
}

/** The /brief page: the SAME brief text the CLI prints (one renderer), plus, for
 * a reviewable high-risk clause, approve/reject buttons that post to the same
 * guarded recordReview path as the CLI (P5). Non-reviewable clauses show only the
 * text — the buttons never appear where the gate would reject them anyway. */
export const renderBriefPage = (
  text: string,
  csrfToken: string,
  key: string,
  briefHash: string,
  reviewable: boolean,
  facts?: ReviewFacts
): string => {
  const fileList = facts && facts.files.length > 0 ? facts.files.join('、') : '（该条款尚无映射代码）'
  const dep = facts?.dependents ?? 0
  const controls = reviewable
    ? `<form id="review-form" data-key="${esc(key)}" data-brief="${esc(briefHash)}">
<p><b>高风险代码审查：${esc(facts?.title ?? key)}</b></p>
<p>映射代码：<code>${esc(fileList)}</code>　下游依赖条款：${dep} 个。证据已通过、元审计已同意，只差人工看代码。判定绑定当前 HEAD。</p>
<p>批准前，可让 AI 基于本条款的条文与代码，现场生成批准/拒绝的具体后果实例：
<select id="explain-auditor"><option value="omp" selected>OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option></select>
<input id="explain-model" value="deepseek/deepseek-v4-flash" aria-label="模型" title="切换客户端会填入该客户端默认模型；可直接修改" />
<button type="button" id="explain-btn">生成实例说明</button></p>
<div id="explain-out" aria-live="polite"></div>
<button type="button" data-d="approve">✓ 批准</button>
<button type="button" data-d="reject">✗ 拒绝</button>
<span id="review-msg" aria-live="polite"></span></form>`
    : ''
  const script = reviewable
    ? `<script>
const csrf = document.querySelector('meta[name=csrf]').content
const form = document.getElementById('review-form')
const msg = document.getElementById('review-msg')
form.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-d]'); if (!b) return
  const decision = b.dataset.d
  const note = prompt(decision === 'approve' ? '请填写一句批准理由（必填）：' : '拒绝理由（可选）：')
  if (note === null) return
  if (decision === 'approve' && !note.trim()) { msg.textContent = '批准必须填写一句理由'; return }
  const r = await fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf },
    body: JSON.stringify({ key: form.dataset.key, decision, briefHash: form.dataset.brief, ...(note.trim() ? { note: note.trim() } : {}) }) })
  const j = await r.json(); if (j.error) { msg.textContent = j.error; return }
  location.href = '/'
})
const explainBtn = document.getElementById('explain-btn')
const explainAuditor = document.getElementById('explain-auditor')
const explainModel = document.getElementById('explain-model')
const defaultModel = { omp: 'deepseek/deepseek-v4-flash', claude: 'sonnet', codex: 'gpt-5.6-terra', traex: 'kimi-k2.6' }
explainAuditor.addEventListener('change', () => { explainModel.value = defaultModel[explainAuditor.value] })
explainBtn.addEventListener('click', async () => {
  const out = document.getElementById('explain-out')
  explainBtn.disabled = true; out.textContent = '正在让 AI 基于本条款生成实例，可能需要一会儿…'
  try {
    const r = await fetch('/api/explain', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key: form.dataset.key, auditor: explainAuditor.value, model: explainModel.value }) })
    const j = await r.json()
    out.textContent = j.error ? j.error : j.text
  } catch { out.textContent = '生成失败，请重试或换一个客户端。' }
  explainBtn.disabled = false
})
</script>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="csrf" content="${esc(csrfToken)}"><title>urtext brief</title>
<style>body{font:14px system-ui;margin:2rem;max-width:70rem}pre{background:#f7f7f7;padding:1rem;overflow-x:auto}button{margin-right:.4rem;cursor:pointer}#review-msg{color:#c00;margin-left:.5rem}#explain-out{white-space:pre-wrap;background:#f7f7f7;padding:.6rem 1rem;border-left:3px solid #7a7;margin:.6rem 0;min-height:1rem}</style>
</head><body><p><a href="/">← console</a></p><pre>${esc(text)}</pre>${controls}${script}</body></html>`
}

export interface DecideResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one adjudication from the UI. Reuses `recordDecision` guards (P2:
 * non-manual clauses rejected; verdict bound to HEAD; a high-risk manual pass
 * additionally requires the current brief-hash — C018). The ui path further
 * requires a one-sentence reason to PASS — one-click approval is exactly
 * where rubber-stamping lives; `fail` is conservative and may omit it. The
 * CLI keeps `note` optional (typing the command is its own deliberation). */
export const handleDecide = (
  db: Database,
  root: string,
  input: unknown,
  decider: string
): DecideResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const { key, verdict, briefHash, note } = input as {
    key?: unknown
    verdict?: unknown
    briefHash?: unknown
    note?: unknown
  }
  if (typeof key !== 'string' || (verdict !== 'pass' && verdict !== 'fail'))
    return { status: 400, body: { error: 'need { key, verdict: pass|fail }' } }
  if (briefHash !== undefined && typeof briefHash !== 'string')
    return { status: 400, body: { error: 'briefHash must be a string' } }
  if (note !== undefined && typeof note !== 'string')
    return { status: 400, body: { error: 'note must be a string' } }
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (verdict === 'pass' && trimmedNote === '')
    return { status: 400, body: { error: 'a one-sentence reason (note) is required to pass' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const specPath = key.slice(0, hash)
  const clauseId = key.slice(hash + 1)
  const outcome = recordDecision(
    db,
    {
      specPath,
      clauseId,
      verdict,
      decider,
      ...(trimmedNote ? { note: trimmedNote } : {}),
      ...(briefHash !== undefined ? { briefHash } : {}),
    },
    root,
    Date.now()
  )
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}
