/**
 * S3 detail/error renderer (urtext-20260724-ui-redesign §3.2/§5/§6.2). Pure
 * string builders over the frozen `BriefPageInput` contract — no DOM, no
 * client state beyond the delegated `BRIEF_SCRIPT` listener.
 */
import type { BriefMapping } from '../brief.js'
import { BRIEF_SCRIPT } from './brief-script.js'
import type { BriefPageInput, SpecImpactView, UiRenderConfig } from './contracts.js'
import { briefHref, esc, pageShell, riskBadge } from './html.js'

const clauseKey = (target: { specPath: string; clauseId: string }): string => `${target.specPath}#${target.clauseId}`

const oracleMeta = (view: SpecImpactView): string =>
  `<p>HEAD <code>${esc(view.head ?? '—')}</code> · oracle: ${esc(view.oracleKind ?? '—')}${
    view.oracleRef !== null ? ` <code>${esc(view.oracleRef)}</code>` : ''
  }</p>`

const evidenceChip = (view: SpecImpactView): string =>
  !view.hasEvidence
    ? `<span data-tone="muted" data-state="no-evidence">○ 尚无证据 — 运行 <code>urtext verify</code></span>`
    : view.stale
      ? `<span data-tone="warn" data-state="stale">⚠ 证据已过期 — 需重新 verify</span>`
      : `<span data-tone="ok" data-state="fresh">✓ 当前有效</span>`

const mappedStatus = (view: SpecImpactView): string =>
  view.mappings.length === 0
    ? '尚无映射代码。先在工作树修改目标范围，再运行 <code>urtext map &lt;spec&gt;#&lt;clause&gt; &lt;file&gt;:&lt;start&gt;-&lt;end&gt;</code>'
    : `${view.mappings.length} 个映射范围`

const dependentsHtml = (view: SpecImpactView): string =>
  view.dependents.length === 0
    ? '无下游依赖'
    : `<ul>${view.dependents
        .map((dependent) => {
          const key = clauseKey(dependent)
          const state = dependent.stale ? 'dependent-stale' : 'dependent-current'
          const label = dependent.stale ? 'stale' : dependent.evidenceVerdict
          return `<li data-state="${state}"><a href="${esc(briefHref(dependent.specPath, dependent.clauseId))}">${esc(key)}</a> ${esc(dependent.title)} — ${esc(label)}</li>`
        })
        .join('')}</ul>`

/** Classifies one raw (unescaped) diff line by its leading ASCII marker
 * before it is escaped for display (§3.2 pt.5). */
const classifyDiffLine = (line: string): 'diff-hunk' | 'diff-add' | 'diff-del' | null =>
  line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : null

const diffLineCounts = (diff: string): { added: number; removed: number } =>
  diff.split('\n').reduce(
    (acc, line) => {
      const cls = classifyDiffLine(line)
      return cls === 'diff-add'
        ? { ...acc, added: acc.added + 1 }
        : cls === 'diff-del'
          ? { ...acc, removed: acc.removed + 1 }
          : acc
    },
    { added: 0, removed: 0 }
  )

const renderDiffBody = (diff: string, config: UiRenderConfig): { html: string; truncated: boolean; total: number } => {
  const lines = diff.split('\n')
  const truncated = lines.length > config.diffDisplayMaxLines
  const shown = truncated ? lines.slice(0, config.diffDisplayMaxLines) : lines
  const html = shown
    .map((line) => {
      const cls = classifyDiffLine(line)
      return cls !== null ? `<span class="${cls}">${esc(line)}</span>` : esc(line)
    })
    .join('\n')
  return { html, truncated, total: lines.length }
}

const renderMappingDiff = (mapping: BriefMapping, index: number, risk: 'low' | 'high', config: UiRenderConfig): string => {
  const range = `${mapping.filePath}:${mapping.lineStart}-${mapping.lineEnd}`
  const titleId = `blame-diff-${index}-title`
  if (mapping.diffError !== null) {
    return `<section data-section="blame-diff-error"><h3 id="${titleId}">${esc(range)}</h3><p>${esc(mapping.diffError)}</p></section>`
  }
  if (mapping.diff === null) {
    return `<section data-section="blame-diff-empty"><h3 id="${titleId}">${esc(range)}</h3><p>映射范围自记录基线以来无代码变化</p></section>`
  }
  const { added, removed } = diffLineCounts(mapping.diff)
  const { html, truncated, total } = renderDiffBody(mapping.diff, config)
  const open = risk === 'high' || total <= config.diffOpenMaxLines
  return `<details data-section="blame-diff"${open ? ' open' : ''}>
<summary id="${titleId}">${esc(range)} · baseline ${esc(mapping.commitSha.slice(0, 7))} · <span data-tone="ok">+${added}</span> <span data-tone="danger">−${removed}</span></summary>
<pre${truncated ? ' data-state="diff-truncated"' : ''}>${html}</pre>${
    truncated ? `<p data-state="diff-truncated">已截断，仅显示前 ${config.diffDisplayMaxLines} 行（共 ${total} 行）</p>` : ''
  }
</details>`
}

const reviewSection = (input: BriefPageInput): string => {
  const fileList = input.facts.files.length > 0 ? input.facts.files.join('、') : '（该条款尚无映射代码）'
  return `<section aria-labelledby="review-title">
<h3 id="review-title">高风险代码审查：${esc(input.facts.title)}</h3>
<p>映射代码：<code>${esc(fileList)}</code>　下游依赖条款：${input.facts.dependents} 个。证据已通过、元审计已同意，只差人工看代码。判定绑定当前 HEAD。</p>
<div>
<label for="explain-auditor">审查客户端</label>
<select id="explain-auditor"><option value="omp" selected>OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option></select>
<label for="explain-model">模型</label>
<input id="explain-model" value="deepseek/deepseek-v4-flash" />
<button type="button" id="explain-btn">生成实例说明</button>
<output id="explain-out" aria-live="polite"></output>
</div>
<form id="review-form" data-key="${esc(input.key)}" data-brief="${esc(input.briefHash)}">
<label for="review-note">批准/拒绝理由（批准必填）</label>
<textarea id="review-note" name="note"></textarea>
<button type="submit" data-v="approve">✓ 批准</button>
<button type="submit" data-v="reject">✗ 拒绝</button>
<output id="review-msg" aria-live="polite"></output>
</form>
</section>`
}

const briefNav = (view: SpecImpactView): string => {
  const previous = view.navigation.previous
  const next = view.navigation.next
  const navPrev = previous
    ? `<a rel="prev" href="${esc(briefHref(previous.specPath, previous.clauseId))}">← 上一条</a>`
    : `<span aria-disabled="true">← 上一条</span>`
  const navNext = next
    ? `<a rel="next" href="${esc(briefHref(next.specPath, next.clauseId))}">下一条 →</a>`
    : `<span aria-disabled="true">下一条 →</span>`
  return `<nav aria-label="页面导航"><a href="/">← console</a> · <a href="/specs">查看全部 Specs</a> · <a href="${esc(
    briefHref(view.target.specPath, view.target.clauseId)
  )}">刷新状态</a> · ${navPrev} · ${navNext}</nav>`
}

/** Renders the clause detail page (§3.2). `input.config` is mandatory — the
 * renderer never reads the environment or falls back to defaults itself. */
export const renderBriefPage = (input: BriefPageInput): string => {
  const { view } = input
  const key = clauseKey(view.target)
  const titlePrefix = `${key} `
  const titleText = input.facts.title.startsWith(titlePrefix) ? input.facts.title.slice(titlePrefix.length) : input.facts.title
  const header = `<header>
<h1 id="brief-title"><code>${esc(key)}</code> ${esc(titleText)}</h1>
${riskBadge(view.risk)}
${oracleMeta(view)}
</header>`
  const main = `<main id="main">
<section id="spec-impact" aria-label="Spec impact">
<p>${evidenceChip(view)}</p>
<section data-section="mappings" aria-labelledby="mappings-title"><h2 id="mappings-title">映射状态</h2><p>${mappedStatus(view)}</p></section>
<section data-section="stale-dependencies" aria-labelledby="stale-dependencies-title"><h2 id="stale-dependencies-title">Stale Dependencies / 下游依赖</h2>${dependentsHtml(view)}<p>${view.impact.affectedTasks.length} 个关联任务</p></section>
${view.mappings.length > 0 ? '<h2>Code Blame Diff</h2>' : ''}
${view.mappings.map((mapping, index) => renderMappingDiff(mapping, index, view.risk, input.config)).join('')}
</section>
<details aria-labelledby="raw-brief-title"><summary id="raw-brief-title">原始裁决简报</summary><pre>${esc(input.text)}</pre></details>
${input.reviewable ? reviewSection(input) : ''}
</main>`
  return pageShell({
    title: 'urtext brief',
    csrfToken: input.csrfToken,
    header,
    nav: briefNav(view),
    main,
    ...(input.reviewable ? { script: `<script>${BRIEF_SCRIPT}</script>` } : {}),
  })
}

/** Fail-closed error page (404/409): same shell, no risk badge, no controls
 * (§3.2 pt.9). */
export const renderBriefErrorPage = (message: string): string =>
  pageShell({
    title: 'urtext brief error',
    header: `<header><h1 id="error-title">无法生成裁决简报</h1></header>`,
    nav: `<nav aria-label="页面导航"><a href="/">← console</a> · <a href="/specs">查看全部 Specs</a> · <a href="/">刷新状态</a></nav>`,
    main: `<main id="main"><p role="alert" data-state="error">${esc(message)}</p></main>`,
  })
