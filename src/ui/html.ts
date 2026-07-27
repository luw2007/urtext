/**
 * Escaped HTML helpers shared by console/brief renderers (urtext-20260724-ui-
 * redesign §6.2). Pure string builders — no DOM, no client script.
 */
import { THEME_CSS } from './theme.js'

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]!)

export const briefHref = (specPath: string, clauseId: string): string =>
  `/brief?spec=${encodeURIComponent(specPath)}&clause=${encodeURIComponent(clauseId)}`

/** Static P5 copy beside every approve/decide control. */
export const approvalSemantics = (head: string | null): string =>
  `本次批准绑定 HEAD ${head?.slice(0, 7) ?? 'n/a'}；代码再动自动失效，需重审。`

export interface ShellInput {
  title: string
  csrfToken?: string
  header: string
  nav: string
  main: string
  script?: string
}

/** Assembles one page. Order is fixed and load-bearing (§3.1/§3.2/§5.1): the
 * skip link is the first focusable element in the body, then header, nav,
 * main, and an optional trailing script — never reordered per-page. */
export const pageShell = (input: ShellInput): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${
    input.csrfToken !== undefined ? `<meta name="csrf-token" content="${esc(input.csrfToken)}">` : ''
  }<title>${esc(input.title)}</title><style>${THEME_CSS}</style></head><body><a class="skip" href="#main">跳到主内容</a>${
    input.header
  }${input.nav}${input.main}${input.script ?? ''}</body></html>`

/** Risk badge: text + symbol + token, never color alone (§3.3). */
export const riskBadge = (risk: 'low' | 'high'): string =>
  risk === 'high'
    ? statusChip('danger', '⚠', 'high', 'risk-high')
    : statusChip('muted', '—', 'low', 'risk-low')

/** A three-channel status chip: text + symbol + color token (§D4/§3.3). */
export const statusChip = (
  kind: 'ok' | 'warn' | 'danger' | 'muted',
  symbol: string,
  label: string,
  dataState?: string
): string =>
  `<span data-tone="${kind}"${dataState !== undefined ? ` data-state="${esc(dataState)}"` : ''}>${esc(symbol)} ${esc(label)}</span>`
