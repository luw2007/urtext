import { describe, expect, test } from 'vitest'

import {
  DEFAULT_UI_RENDER_CONFIG,
  readUiRenderConfig,
  type UiRenderConfig,
} from '../src/ui/contracts.js'
import { briefHref, esc, pageShell, riskBadge, statusChip, type ShellInput } from '../src/ui/html.js'
import { THEME_CSS } from '../src/ui/theme.js'

// ---------------------------------------------------------------------------
// UiRenderConfig: defaults, env overrides, fail-fast on invalid values
// ---------------------------------------------------------------------------

describe('DEFAULT_UI_RENDER_CONFIG', () => {
  test('defaults to 80/2000', () => {
    expect(DEFAULT_UI_RENDER_CONFIG).toEqual<UiRenderConfig>({
      diffOpenMaxLines: 80,
      diffDisplayMaxLines: 2000,
    })
  })
})

describe('readUiRenderConfig', () => {
  test('falls back to defaults when env is empty', () => {
    expect(readUiRenderConfig({})).toEqual(DEFAULT_UI_RENDER_CONFIG)
  })

  test('honors both overrides when both are valid positive integers', () => {
    expect(
      readUiRenderConfig({
        URTEXT_UI_DIFF_OPEN_MAX_LINES: '40',
        URTEXT_UI_DIFF_DISPLAY_MAX_LINES: '500',
      })
    ).toEqual({ diffOpenMaxLines: 40, diffDisplayMaxLines: 500 })
  })

  test('honors one override, defaults the other', () => {
    expect(readUiRenderConfig({ URTEXT_UI_DIFF_OPEN_MAX_LINES: '10' })).toEqual({
      diffOpenMaxLines: 10,
      diffDisplayMaxLines: 2000,
    })
  })

  for (const bad of ['0', '-1', '1.5', 'abc', '', ' 5', '5 ', '+5', '1e3', 'NaN']) {
    test(`fails fast on diffOpenMaxLines=${JSON.stringify(bad)}`, () => {
      expect(() => readUiRenderConfig({ URTEXT_UI_DIFF_OPEN_MAX_LINES: bad })).toThrow()
    })
    test(`fails fast on diffDisplayMaxLines=${JSON.stringify(bad)}`, () => {
      expect(() => readUiRenderConfig({ URTEXT_UI_DIFF_DISPLAY_MAX_LINES: bad })).toThrow()
    })
  }
})

// ---------------------------------------------------------------------------
// esc(): exact escaping semantics preserved from review-ui.ts
// ---------------------------------------------------------------------------

describe('esc', () => {
  test('escapes &, <, >, ", \' in order', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  test('coerces null/undefined to empty string', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
  })

  test('coerces non-string values via String()', () => {
    expect(esc(42)).toBe('42')
    expect(esc(true)).toBe('true')
  })

  test('leaves plain text untouched', () => {
    expect(esc('plain text 123')).toBe('plain text 123')
  })

  test('does not double-escape an already-escaped ampersand', () => {
    expect(esc('&amp;')).toBe('&amp;amp;')
  })
})

// ---------------------------------------------------------------------------
// briefHref(): href encoding
// ---------------------------------------------------------------------------

describe('briefHref', () => {
  test('builds the /brief path with encoded query params', () => {
    expect(briefHref('specs/x/spec.md', 'C001')).toBe('/brief?spec=specs%2Fx%2Fspec.md&clause=C001')
  })

  test('encodes spaces, ampersands, and unicode in both params', () => {
    expect(briefHref('specs/a b&c/spec.md', 'C 001 中')).toBe(
      `/brief?spec=${encodeURIComponent('specs/a b&c/spec.md')}&clause=${encodeURIComponent('C 001 中')}`
    )
  })
  test('never emits an unencoded query-breaking character', () => {
    const href = briefHref('a&b=c', 'x"y<z')
    const query = href.slice(href.indexOf('?') + 1)
    expect(query.match(/&/g)).toHaveLength(1)
    expect(decodeURIComponent(href.match(/spec=([^&]*)/)![1]!)).toBe('a&b=c')
    expect(decodeURIComponent(href.match(/clause=([^&]*)/)![1]!)).toBe('x"y<z')
  })
})

// ---------------------------------------------------------------------------
// riskBadge / statusChip: three-channel status (text + symbol + token)
// ---------------------------------------------------------------------------

describe('statusChip', () => {
  test('renders tone, escaped symbol, and escaped label', () => {
    expect(statusChip('ok', '✓', 'pass')).toBe('<span data-tone="ok">✓ pass</span>')
  })

  test('adds data-state only when provided', () => {
    expect(statusChip('warn', '⚠', 'stale', 'stale')).toBe(
      '<span data-tone="warn" data-state="stale">⚠ stale</span>'
    )
  })

  test('escapes an untrusted label to prevent HTML injection', () => {
    expect(statusChip('danger', '✗', '<script>alert(1)</script>')).toBe(
      '<span data-tone="danger">✗ &lt;script&gt;alert(1)&lt;/script&gt;</span>'
    )
  })
})

describe('riskBadge', () => {
  test('high risk: danger tone, warning symbol, risk-high state', () => {
    expect(riskBadge('high')).toBe('<span data-tone="danger" data-state="risk-high">⚠ high</span>')
  })

  test('low risk: muted tone, dash symbol, risk-low state', () => {
    expect(riskBadge('low')).toBe('<span data-tone="muted" data-state="risk-low">— low</span>')
  })
})

// ---------------------------------------------------------------------------
// pageShell: skip link / header / nav / main / script order and structure
// ---------------------------------------------------------------------------

const baseShell: ShellInput = {
  title: 'urtext console',
  header: '<header><h1>H</h1></header>',
  nav: '<nav aria-label="页面导航">N</nav>',
  main: '<main id="main">M</main>',
}

describe('pageShell', () => {
  test('doctype/html/head come before body content', () => {
    const html = pageShell(baseShell)
    expect(html.startsWith('<!doctype html><html lang="zh-CN"><head>')).toBe(true)
  })

  test('the skip link is the first element inside body, before header', () => {
    const html = pageShell(baseShell)
    const bodyStart = html.indexOf('<body>')
    const skipIndex = html.indexOf('<a class="skip" href="#main">', bodyStart)
    const headerIndex = html.indexOf('<header>', bodyStart)
    expect(skipIndex).toBeGreaterThan(bodyStart)
    expect(skipIndex).toBeLessThan(headerIndex)
  })

  test('landmark order is skip -> header -> nav -> main -> script', () => {
    const html = pageShell({ ...baseShell, script: '<script>1</script>' })
    const order = ['<a class="skip"', '<header>', '<nav ', '<main id="main">', '<script>1</script>']
    let cursor = -1
    for (const marker of order) {
      const idx = html.indexOf(marker)
      expect(idx).toBeGreaterThan(cursor)
      cursor = idx
    }
    expect(html.endsWith('<script>1</script></body></html>')).toBe(true)
  })

  test('omitting script leaves no trailing script tag and body closes right after main', () => {
    const html = pageShell(baseShell)
    expect(html).not.toContain('<script>')
    expect(html.endsWith('<main id="main">M</main></body></html>')).toBe(true)
  })

  test('escapes the title', () => {
    const html = pageShell({ ...baseShell, title: '<b>x</b>' })
    expect(html).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>')
  })

  test('emits csrf meta tag only when csrfToken is provided, and escapes it', () => {
    const withToken = pageShell({ ...baseShell, csrfToken: 'tok"en' })
    expect(withToken).toContain('<meta name="csrf-token" content="tok&quot;en">')
    const withoutToken = pageShell(baseShell)
    expect(withoutToken).not.toContain('csrf-token')
  })

  test('embeds THEME_CSS verbatim inside a single <style> tag', () => {
    const html = pageShell(baseShell)
    expect(html).toContain(`<style>${THEME_CSS}</style>`)
  })
})

// ---------------------------------------------------------------------------
// Accessibility tokens present in THEME_CSS: focus-visible, dark theme,
// reduced-motion.
// ---------------------------------------------------------------------------

describe('THEME_CSS accessibility tokens', () => {
  test('defines a :focus-visible outline', () => {
    expect(THEME_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/)
  })

  test('defines a dark theme via prefers-color-scheme', () => {
    expect(THEME_CSS).toMatch(/@media \(prefers-color-scheme: dark\)\{:root\{/)
  })

  test('disables transition/animation under prefers-reduced-motion: reduce', () => {
    const match = THEME_CSS.match(/@media \(prefers-reduced-motion: reduce\)\{([^}]*\{[^}]*\})\}/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain('transition:none!important')
    expect(match![1]).toContain('animation:none!important')
  })

  test('imports no external resources (no url(), @import, or http(s) references)', () => {
    expect(THEME_CSS).not.toMatch(/@import/)
    expect(THEME_CSS).not.toMatch(/url\(/)
    expect(THEME_CSS).not.toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// Contrast: representative pairs from §5.2 must clear WCAG AA (>=4.5:1) for
// normal text, in both light and dark themes.
// ---------------------------------------------------------------------------

const extractBlock = (css: string, startMarker: string): string => {
  const start = css.indexOf(startMarker)
  if (start === -1) throw new Error(`marker not found: ${startMarker}`)
  let depth = 0
  let i = start
  let blockStart = -1
  for (; i < css.length; i++) {
    if (css[i] === '{') {
      depth++
      if (depth === 1) blockStart = i + 1
    } else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(blockStart, i)
    }
  }
  throw new Error(`unterminated block: ${startMarker}`)
}

const parseTokens = (block: string): Record<string, string> => {
  const tokens: Record<string, string> = {}
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    tokens[m[1]!] = m[2]!
  }
  return tokens
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.slice(1)
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrastRatio = (hexA: string, hexB: string): number => {
  const lA = relativeLuminance(hexToRgb(hexA))
  const lB = relativeLuminance(hexToRgb(hexB))
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA]
  return (lighter + 0.05) / (darker + 0.05)
}

const lightTokens = parseTokens(extractBlock(THEME_CSS, ':root{'))
const darkBlockStart = THEME_CSS.indexOf('@media (prefers-color-scheme: dark)')
const darkTokens = parseTokens(THEME_CSS.slice(darkBlockStart))

const pairs: Array<[string, string]> = [
  ['fg', 'bg'],
  ['muted', 'bg'],
  ['accent', 'bg'],
  ['accent', 'accent-bg'],
  ['ok', 'bg'],
  ['ok', 'ok-bg'],
  ['warn', 'warn-bg'],
  ['warn', 'bg'],
  ['danger', 'bg'],
  ['danger', 'danger-bg'],
]

describe.each([
  ['light', lightTokens],
  ['dark', darkTokens],
])('%s theme contrast pairs', (_themeName, tokens) => {
  test.each(pairs)('%s / %s clears 4.5:1', (fgName, bgName) => {
    const fg = tokens[fgName]
    const bg = tokens[bgName]
    expect(fg, `missing token --${fgName}`).toBeDefined()
    expect(bg, `missing token --${bgName}`).toBeDefined()
    expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(4.5)
  })
})
