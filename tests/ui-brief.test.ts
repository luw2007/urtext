import { describe, expect, test } from 'vitest'

import type { BriefMapping } from '../src/brief.js'
import { BRIEF_SCRIPT } from '../src/ui/brief-script.js'
import type { BriefPageInput, SpecImpactView } from '../src/ui/contracts.js'
import { DEFAULT_UI_RENDER_CONFIG } from '../src/ui/contracts.js'
import { renderBriefErrorPage, renderBriefPage } from '../src/ui/render-brief.js'

const baseView = (overrides: Partial<SpecImpactView> = {}): SpecImpactView => ({
  schema: 'urtext.spec-impact/1',
  head: 'abc1234',
  target: { specPath: 'specs/x/spec.md', clauseId: 'C001' },
  oracleKind: 'cmd',
  oracleRef: 'true',
  risk: 'low',
  stale: false,
  hasEvidence: true,
  requirementBindings: [
    {
      state: 'resolved',
      rawTarget: 'FR001',
      target: { specPath: 'specs/x/spec.md', reqId: 'FR001', title: 'base intent' },
    },
  ],
  mappings: [],
  impact: { source: { specPath: 'specs/x/spec.md', clauseId: 'C001' }, affectedClauses: [], affectedTasks: [] },
  dependents: [],
  navigation: { previous: null, next: null },
  ...overrides,
})

const baseInput = (overrides: Partial<BriefPageInput> = {}): BriefPageInput => ({
  text: 'raw brief text',
  csrfToken: 'tok',
  key: 'specs/x/spec.md#C001',
  briefHash: 'hash123',
  reviewable: false,
  facts: { title: 'specs/x/spec.md#C001 base clause', files: [], dependents: 0 },
  view: baseView(),
  config: DEFAULT_UI_RENDER_CONFIG,
  ...overrides,
})

const mapping = (overrides: Partial<BriefMapping> = {}): BriefMapping => ({
  filePath: 'src/impl.ts',
  lineStart: 2,
  lineEnd: 2,
  commitSha: 'abcdef0123',
  note: null,
  content: 'new',
  diff: null,
  diffError: null,
  ...overrides,
})

describe('renderBriefPage: shell, landmarks, single h1', () => {
  test('skip link is the first focusable element, before header/nav/main', () => {
    const html = renderBriefPage(baseInput())
    const bodyStart = html.indexOf('<body>')
    const skipIndex = html.indexOf('<a class="skip" href="#main">')
    const headerIndex = html.indexOf('<header>')
    const navIndex = html.indexOf('<nav ')
    const mainIndex = html.indexOf('<main id="main">')
    expect(bodyStart).toBeGreaterThan(-1)
    expect(skipIndex).toBeGreaterThan(bodyStart)
    expect(skipIndex).toBeLessThan(headerIndex)
    expect(headerIndex).toBeLessThan(navIndex)
    expect(navIndex).toBeLessThan(mainIndex)
  })

  test('exactly one h1, html lang set, no inline handlers or external resources', () => {
    const html = renderBriefPage(baseInput())
    expect(html.match(/<h1[ >]/g)?.length).toBe(1)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).not.toMatch(/\son[a-z]+=/i)
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('prompt(')
    expect(html).not.toContain('alert(')
  })

  test('every aria-labelledby target exists and is unique', () => {
    const html = renderBriefPage(
      baseInput({
        reviewable: true,
        view: baseView({ risk: 'high', mappings: [mapping({ diff: '@@ -2 +2 @@\n-old\n+new' })] }),
      })
    )
    const refs = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1])
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    for (const ref of refs) expect(ids.filter((id) => id === ref)).toHaveLength(1)
  })
})

describe('renderBriefPage: header, nav, oracle metadata', () => {
  test('title splits the clause key from the clause title, risk badge and oracle line render', () => {
    const html = renderBriefPage(baseInput())
    expect(html).toContain('<h1 id="brief-title"><code>specs/x/spec.md#C001</code> base clause</h1>')
    expect(html).toContain('risk-low')
    expect(html).toContain('oracle: cmd')
    expect(html).toContain('<code>true</code>')
    expect(html).toContain('<code>abc1234</code>')
  })

  test('nav renders console/all-specs/refresh and disabled prev/next when absent', () => {
    const html = renderBriefPage(baseInput())
    expect(html).toContain('<nav aria-label="页面导航">')
    expect(html).toContain('← console')
    expect(html).toContain('查看全部 Specs')
    expect(html).toContain('/brief?spec=specs%2Fx%2Fspec.md&amp;clause=C001')
    expect(html).toContain('<span aria-disabled="true">← 上一条</span>')
    expect(html).toContain('<span aria-disabled="true">下一条 →</span>')
  })

  test('nav links prev/next with rel attributes when present', () => {
    const html = renderBriefPage(
      baseInput({
        view: baseView({
          navigation: {
            previous: { specPath: 'specs/x/spec.md', clauseId: 'C000' },
            next: { specPath: 'specs/x/spec.md', clauseId: 'C002' },
          },
        }),
      })
    )
    expect(html).toContain('rel="prev"')
    expect(html).toContain('rel="next"')
    expect(html).toContain('clause=C000')
    expect(html).toContain('clause=C002')
  })
})

describe('renderBriefPage: evidence, mapping, dependency states', () => {
  test('no-evidence state', () => {
    const html = renderBriefPage(baseInput({ view: baseView({ hasEvidence: false }) }))
    expect(html).toContain('data-state="no-evidence"')
    expect(html).toContain('urtext verify')
  })

  test('stale evidence state', () => {
    const html = renderBriefPage(baseInput({ view: baseView({ stale: true }) }))
    expect(html).toContain('data-state="stale"')
  })

  test('fresh evidence state', () => {
    const html = renderBriefPage(baseInput())
    expect(html).toContain('data-state="fresh"')
  })

  test('empty mappings show the map command template', () => {
    const html = renderBriefPage(baseInput())
    expect(html).toContain('data-section="mappings"')
    expect(html).toContain('urtext map')
  })

  test('empty dependents show the empty state, non-empty show stale/current classes', () => {
    const empty = renderBriefPage(baseInput())
    expect(empty).toContain('无下游依赖')

    const withDeps = renderBriefPage(
      baseInput({
        view: baseView({
          dependents: [
            { specPath: 'specs/x/spec.md', clauseId: 'C002', title: 'dependent', stale: true, evidenceVerdict: 'pass' },
            { specPath: 'specs/x/spec.md', clauseId: 'C003', title: 'other', stale: false, evidenceVerdict: 'fail' },
          ],
        }),
      })
    )
    expect(withDeps).toContain('data-state="dependent-stale"')
    expect(withDeps).toContain('data-state="dependent-current"')
    expect(withDeps).toContain('fail')
  })
})

describe('renderBriefPage: escaped mapping diffs, ASCII line classes, +/- counts, thresholds', () => {
  test('diff lines are classified and escaped: no raw injected markup survives', () => {
    const html = renderBriefPage(
      baseInput({
        view: baseView({
          mappings: [
            mapping({
              filePath: 'src/<impl>.ts',
              diff: '@@ -2 +2 @@\n-const old = "<unsafe>"\n+const next = 1\n context',
            }),
          ],
        }),
      })
    )
    expect(html).toContain('data-section="blame-diff"')
    expect(html).toContain('src/&lt;impl&gt;.ts:2-2')
    expect(html).toContain('<span class="diff-hunk">@@ -2 +2 @@</span>')
    expect(html).toContain('<span class="diff-del">-const old = &quot;&lt;unsafe&gt;&quot;</span>')
    expect(html).toContain('<span class="diff-add">+const next = 1</span>')
    expect(html).not.toContain('<unsafe>')
    expect(html).not.toContain('<impl>')
  })

  test('+/- counts render from the classified lines', () => {
    const html = renderBriefPage(
      baseInput({
        view: baseView({
          mappings: [mapping({ diff: '@@ -1,2 +1,3 @@\n+a\n+b\n-c' })],
        }),
      })
    )
    expect(html).toContain('+2')
    expect(html).toContain('−1')
  })

  test('empty mapping diff renders blame-diff-empty with the exact copy', () => {
    const html = renderBriefPage(baseInput({ view: baseView({ mappings: [mapping({ diff: null })] }) }))
    expect(html).toContain('data-section="blame-diff-empty"')
    expect(html).toContain('映射范围自记录基线以来无代码变化')
  })

  test('mapping diff error renders blame-diff-error with the escaped message', () => {
    const html = renderBriefPage(
      baseInput({ view: baseView({ mappings: [mapping({ diffError: '<binary> diff is not supported' })] }) })
    )
    expect(html).toContain('data-section="blame-diff-error"')
    expect(html).toContain('&lt;binary&gt; diff is not supported')
  })

  test('empty and error mapping states keep the brief heading hierarchy contiguous', () => {
    const html = renderBriefPage(
      baseInput({
        view: baseView({
          mappings: [mapping({ diff: null }), mapping({ diffError: 'binary diff is not supported' })],
        }),
      })
    )
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]))
    expect(levels[0]).toBe(1)
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1)
    }
  })

  test('high-risk mapping opens regardless of line count; low-risk opens only under the threshold', () => {
    const bigDiff = ['@@ -1,50 +1,50 @@', ...Array.from({ length: 3 }, (_, i) => `+line${i}`)].join('\n')
    const config = { diffOpenMaxLines: 2, diffDisplayMaxLines: 2000 }

    const highRiskOpen = renderBriefPage(
      baseInput({ config, view: baseView({ risk: 'high', mappings: [mapping({ diff: bigDiff })] }) })
    )
    expect(highRiskOpen).toMatch(/<details data-section="blame-diff" open>/)

    const lowRiskClosed = renderBriefPage(
      baseInput({ config, view: baseView({ risk: 'low', mappings: [mapping({ diff: bigDiff })] }) })
    )
    expect(lowRiskClosed).toMatch(/<details data-section="blame-diff">/)

    const smallDiff = '@@ -1 +1 @@\n+a'
    const lowRiskOpen = renderBriefPage(
      baseInput({ config, view: baseView({ risk: 'low', mappings: [mapping({ diff: smallDiff })] }) })
    )
    expect(lowRiskOpen).toMatch(/<details data-section="blame-diff" open>/)
  })

  test('diff display truncates at diffDisplayMaxLines and marks the truncation state', () => {
    const lines = ['@@ -1,5 +1,5 @@', ...Array.from({ length: 5 }, (_, i) => `+line${i}`)]
    const diff = lines.join('\n')
    const config = { diffOpenMaxLines: 80, diffDisplayMaxLines: 3 }
    const html = renderBriefPage(baseInput({ config, view: baseView({ mappings: [mapping({ diff })] }) }))
    expect(html).toContain('data-state="diff-truncated"')
    expect(html).toContain('仅显示前 3 行')
    expect(html).not.toContain('line4')
  })
})

describe('renderBriefPage: raw brief disclosure and review/explain form', () => {
  test('raw brief text is escaped inside a details/summary disclosure', () => {
    const html = renderBriefPage(baseInput({ text: '<script>alert(1)</script>' }))
    expect(html).toContain('<details aria-labelledby="raw-brief-title"><summary id="raw-brief-title">原始裁决简报</summary>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('reviewable=false renders no review section, no explain controls, no inline script', () => {
    const html = renderBriefPage(baseInput({ reviewable: false }))
    expect(html).not.toContain('id="review-form"')
    expect(html).not.toContain('id="explain-btn"')
    expect(html).not.toContain('<script>')
  })

  test('reviewable=true renders the review form, explain controls, and the delegated script', () => {
    const html = renderBriefPage(
      baseInput({
        reviewable: true,
        key: 'specs/x/spec.md#C001',
        briefHash: 'hash999',
        facts: { title: 'specs/x/spec.md#C001 base clause', files: ['src/impl.ts'], dependents: 2 },
      })
    )
    expect(html).toContain('<section aria-labelledby="review-title">')
    expect(html).toContain('<form id="review-form" data-key="specs/x/spec.md#C001" data-brief="hash999">')
    expect(html).toContain('<label for="review-note">')
    expect(html).toContain('data-v="approve"')
    expect(html).toContain('data-v="reject"')
    expect(html).toContain('id="review-msg" aria-live="polite"')
    expect(html).toContain('id="explain-auditor"')
    expect(html).toContain('id="explain-model"')
    expect(html).toContain('id="explain-btn"')
    expect(html).toContain('id="explain-out" aria-live="polite"')
    expect(html).toContain(`<script>${BRIEF_SCRIPT}</script>`)
    expect(html).toContain('src/impl.ts')
  })
})

describe('BRIEF_SCRIPT: no prompt/alert, delegated form handling', () => {
  test('script never calls prompt() or alert()', () => {
    expect(BRIEF_SCRIPT).not.toContain('prompt(')
    expect(BRIEF_SCRIPT).not.toContain('alert(')
  })

  test('script reads csrf from the meta tag and posts to /api/review and /api/explain', () => {
    expect(BRIEF_SCRIPT).toContain('meta[name="csrf-token"]')
    expect(BRIEF_SCRIPT).toContain('/api/review')
    expect(BRIEF_SCRIPT).toContain('/api/explain')
  })
})

describe('renderBriefErrorPage: fail-closed shell', () => {
  test('shell with skip link, header, nav, single alert, no risk badge or controls', () => {
    const html = renderBriefErrorPage('[unknown_clause] no such clause')
    const bodyStart = html.indexOf('<body>')
    const skipIndex = html.indexOf('<a class="skip" href="#main">')
    expect(skipIndex).toBeGreaterThan(bodyStart)
    expect(html).toContain('<h1 id="error-title">无法生成裁决简报</h1>')
    expect(html).toContain('<nav aria-label="页面导航">')
    expect(html).toContain('<p role="alert" data-state="error">[unknown_clause] no such clause</p>')
    expect(html.match(/<h1[ >]/g)?.length).toBe(1)
    expect(html).not.toContain('data-state="risk-')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('prompt(')
    expect(html).not.toContain('alert(')
  })

  test('escapes the error message', () => {
    const html = renderBriefErrorPage('<script>bad</script>')
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(html).not.toContain('<script>bad</script>')
  })
})
