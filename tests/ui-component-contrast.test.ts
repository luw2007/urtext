/**
 * J2 joint verification (urtext-20260724-ui-redesign §5.2/§7.2). Validates the
 * committed `tests/ui-contrast-manifest.json` against the live renderer/theme
 * sources: schema shape, source/render hash freshness, visible-branch
 * coverage, authored §5.2 token-pair registration, real light/dark contrast
 * math, and bidirectional selector/state enumeration. No browser: colors are
 * resolved from `theme.ts`'s own CSS text, not asserted as literals here.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import type { UiSnapshot } from '../src/review-ui.js'
import { renderBriefErrorPage, renderBriefPage } from '../src/ui/render-brief.js'
import { renderConsolePage } from '../src/ui/render-console.js'
import type { BriefPageInput } from '../src/ui/contracts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// Manifest / fixture types (mirror the JSON contract; JSON.parse is an
// unchecked boundary — every field is verified by the tests below).
// ---------------------------------------------------------------------------

type Page = 'console' | 'brief' | 'error'
type ConsumerState = 'default' | 'disabled' | 'focus-visible'

interface ConsoleFixture {
  id: string
  page: 'console'
  branches: string[]
  snapshot: UiSnapshot
  csrfToken: string
  auditResult?: string
}
interface BriefFixture {
  id: string
  page: 'brief'
  branches: string[]
  input: BriefPageInput
}
interface ErrorFixture {
  id: string
  page: 'error'
  branches: string[]
  message: string
}
type Fixture = ConsoleFixture | BriefFixture | ErrorFixture

interface ContrastConsumer {
  id: string
  page: Page
  fixture: string
  selector: string
  state: ConsumerState
  foregroundToken: string
  backgroundToken: string
}

interface ContrastManifest {
  schema: 'urtext.ui-contrast-consumers/2'
  sourceContractSha256: string
  renderContractSha256: string
  fixtureMatrix: Fixture[]
  consumers: ContrastConsumer[]
}

const manifestPath = join(__dirname, 'ui-contrast-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ContrastManifest

// ---------------------------------------------------------------------------
// §5.2 length-delimited hash framing: `path + "\0" + byteLength + "\0" + bytes + "\0"`
// ---------------------------------------------------------------------------

const SOURCE_FILES = [
  'src/ui/theme.ts',
  'src/ui/html.ts',
  'src/ui/render-console.ts',
  'src/ui/render-brief.ts',
  'src/ui/console-script.ts',
  'src/ui/brief-script.ts',
] as const

const frame = (path: string, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${path}\0${bytes.byteLength}\0`, 'utf8'), bytes, Buffer.from('\0', 'utf8')])

const renderFixture = (fixture: Fixture): string => {
  if (fixture.page === 'console') return renderConsolePage(fixture.snapshot, fixture.csrfToken, fixture.auditResult)
  if (fixture.page === 'brief') return renderBriefPage(fixture.input)
  return renderBriefErrorPage(fixture.message)
}

describe('ui contrast manifest — freshness', () => {
  test('sourceContractSha256 matches the six source files + fixtureMatrix bytes, re-read now', () => {
    const hash = createHash('sha256')
    for (const path of SOURCE_FILES) hash.update(frame(path, readFileSync(join(ROOT, path))))
    hash.update(frame('fixtureMatrix', Buffer.from(JSON.stringify(manifest.fixtureMatrix), 'utf8')))
    expect(hash.digest('hex')).toBe(manifest.sourceContractSha256)
  })

  test('renderContractSha256 matches fresh renderer output for every fixture, re-rendered now', () => {
    const hash = createHash('sha256')
    for (const fixture of manifest.fixtureMatrix) hash.update(frame(fixture.id, Buffer.from(renderFixture(fixture), 'utf8')))
    expect(hash.digest('hex')).toBe(manifest.renderContractSha256)
  })
})

describe('ui contrast manifest — schema', () => {
  test('top-level schema tag and structural shape', () => {
    expect(manifest.schema).toBe('urtext.ui-contrast-consumers/2')
    expect(manifest.sourceContractSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.renderContractSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Array.isArray(manifest.fixtureMatrix)).toBe(true)
    expect(manifest.fixtureMatrix.length).toBeGreaterThan(0)
    expect(Array.isArray(manifest.consumers)).toBe(true)
    expect(manifest.consumers.length).toBeGreaterThan(0)
  })

  test('every fixture id is unique and page is console|brief|error', () => {
    const ids = manifest.fixtureMatrix.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const fixture of manifest.fixtureMatrix) expect(['console', 'brief', 'error']).toContain(fixture.page)
  })

  test('every consumer has a unique id, references a declared fixture, and uses allowed page/state enums', () => {
    const fixtureById = new Map(manifest.fixtureMatrix.map((f) => [f.id, f]))
    const seen = new Set<string>()
    for (const consumer of manifest.consumers) {
      expect(seen.has(consumer.id), `duplicate consumer id ${consumer.id}`).toBe(false)
      seen.add(consumer.id)
      expect(['console', 'brief', 'error']).toContain(consumer.page)
      expect(['default', 'disabled', 'focus-visible']).toContain(consumer.state)
      const fixture = fixtureById.get(consumer.fixture)
      expect(fixture, `consumer ${consumer.id} references unknown fixture ${consumer.fixture}`).toBeDefined()
      expect(fixture!.page).toBe(consumer.page)
    }
  })
})

// ---------------------------------------------------------------------------
// Visible-branch coverage: the canonical set of reachable render branches
// (§5.2/§7.2 J2). Every id must be covered by ≥1 fixture; no unknown ids.
// ---------------------------------------------------------------------------

const CANONICAL_BRANCHES = [
  'console.human.empty',
  'console.human.nonEmpty',
  'console.agentLane.open',
  'console.agentLane.closed',
  'console.unmapped.clean',
  'console.unmapped.hunks',
  'console.unmapped.error',
  'console.wip.normal',
  'console.wip.exceeded',
  'console.audit.absent',
  'console.audit.present',
  'console.decided.empty',
  'console.decided.nonEmpty',
  'brief.risk.low',
  'brief.risk.high',
  'brief.reviewable.false',
  'brief.reviewable.true',
  'brief.evidence.fresh',
  'brief.evidence.stale',
  'brief.evidence.noEvidence',
  'brief.mapping.normal',
  'brief.mapping.empty',
  'brief.mapping.error',
  'brief.mapping.truncated',
  'brief.dependent.current',
  'brief.dependent.stale',
  'brief.dependent.empty',
  'brief.nav.prevPresent',
  'brief.nav.prevAbsent',
  'brief.nav.nextPresent',
  'brief.nav.nextAbsent',
  'error.page',
] as const

describe('ui contrast manifest — visible-branch coverage', () => {
  test('every canonical branch id is covered by a fixture, and no fixture declares an unknown id', () => {
    const declared = new Set<string>()
    for (const fixture of manifest.fixtureMatrix) {
      for (const branch of fixture.branches) {
        expect(CANONICAL_BRANCHES as readonly string[], `fixture ${fixture.id} declares unknown branch ${branch}`).toContain(branch)
        declared.add(branch)
      }
    }
    for (const branch of CANONICAL_BRANCHES) expect(declared.has(branch), `no fixture covers branch ${branch}`).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §5.2 registered selector → token-pair mapping (reachable subset only: dead
// CSS such as `.surface`/`[data-tone="accent"]` has no real consumer and is
// intentionally excluded — a manifest entry for it would fail the
// manifest→real reachability check below).
// ---------------------------------------------------------------------------

const REGISTERED_PAIRS: Record<string, { fg: string; bg: string }> = {
  'body,main': { fg: 'fg', bg: 'bg' },
  table: { fg: 'fg', bg: 'surface' },
  a: { fg: 'accent', bg: 'bg' },
  'table a': { fg: 'accent', bg: 'surface' },
  '[data-tone="muted"]': { fg: 'muted', bg: 'bg' },
  '[data-tone="ok"]': { fg: 'ok', bg: 'ok-bg' },
  '.diff-add': { fg: 'ok', bg: 'ok-bg' },
  '[data-tone="warn"]': { fg: 'warn', bg: 'warn-bg' },
  '.diff-hunk': { fg: 'warn', bg: 'warn-bg' },
  '[data-tone="danger"]': { fg: 'danger', bg: 'danger-bg' },
  '.diff-del': { fg: 'danger', bg: 'danger-bg' },
  '[role="alert"]': { fg: 'danger', bg: 'danger-bg' },
}

/** Detection must ignore the embedded `<style>` block: THEME_CSS's own
 * selector text (e.g. `[role="alert"]`, `[data-tone="ok"]`) would otherwise
 * register as a false-positive match for the same substring in the body. */
const bodyOnly = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, '')

const withinTables = (html: string): string[] => [...bodyOnly(html).matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0])

const SELECTOR_DETECTORS: Record<string, (html: string) => boolean> = {
  'body,main': (html) => /<body>/.test(html) && /<main id="main">/.test(html),
  a: (html) => /<a\s/.test(bodyOnly(html)),
  table: (html) => /<table>/.test(bodyOnly(html)),
  'table a': (html) => withinTables(html).some((t) => /<a\s/.test(t)),
  '[data-tone="muted"]': (html) => /data-tone="muted"/.test(bodyOnly(html)),
  '[data-tone="ok"]': (html) => /data-tone="ok"/.test(bodyOnly(html)),
  '[data-tone="warn"]': (html) => /data-tone="warn"/.test(bodyOnly(html)),
  '[data-tone="danger"]': (html) => /data-tone="danger"/.test(bodyOnly(html)),
  '[role="alert"]': (html) => /role="alert"/.test(bodyOnly(html)),
  '.diff-add': (html) => /class="diff-add"/.test(bodyOnly(html)),
  '.diff-hunk': (html) => /class="diff-hunk"/.test(bodyOnly(html)),
  '.diff-del': (html) => /class="diff-del"/.test(bodyOnly(html)),
}

/** Elements that are inherently keyboard-focusable — the only selectors for
 * which a `focus-visible` consumer row is legitimate (§5.1 focus-visible
 * rule applies to any focusable element, not to non-interactive spans). */
const FOCUSABLE_SELECTORS = new Set(['a'])

describe('ui contrast manifest — authored §5.2 token pairs', () => {
  test('every consumer selector is registered and its tokens match the authored pair exactly', () => {
    for (const consumer of manifest.consumers) {
      const registered = REGISTERED_PAIRS[consumer.selector]
      expect(registered, `unregistered selector ${JSON.stringify(consumer.selector)} on consumer ${consumer.id}`).toBeDefined()
      expect(consumer.foregroundToken, `${consumer.id} foregroundToken`).toBe(registered.fg)
      expect(consumer.backgroundToken, `${consumer.id} backgroundToken`).toBe(registered.bg)
    }
  })
})

// ---------------------------------------------------------------------------
// Real CSS token resolution + WCAG contrast math (no browser — computed here
// from theme.ts's own text, for both the light `:root` block and the dark
// `prefers-color-scheme` override block).
// ---------------------------------------------------------------------------

const THEME_SOURCE = readFileSync(join(ROOT, 'src/ui/theme.ts'), 'utf8')

const parseTokenBlock = (css: string): Record<string, string> => {
  const tokens: Record<string, string> = {}
  for (const m of css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,8})/g)) tokens[m[1]] = m[2]
  return tokens
}

const rootBlockMatch = THEME_SOURCE.match(/:root\{([^}]*)\}/)
if (!rootBlockMatch) throw new Error('theme.ts: no :root block found — cannot resolve light tokens')
const lightTokens = parseTokenBlock(rootBlockMatch[1])

const darkBlockMatch = THEME_SOURCE.match(/prefers-color-scheme: dark\)\{:root\{([^}]*)\}\}/)
if (!darkBlockMatch) throw new Error('theme.ts: no dark :root override block found — cannot resolve dark tokens')
const darkTokens = { ...lightTokens, ...parseTokenBlock(darkBlockMatch[1]) }

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.slice(1)
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)]
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
}

const contrastRatio = (fgHex: string, bgHex: string): number => {
  const l1 = relativeLuminance(hexToRgb(fgHex))
  const l2 = relativeLuminance(hexToRgb(bgHex))
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

describe('ui contrast manifest — computed light/dark contrast ≥ 4.5', () => {
  test('every consumer pair resolves to a real hex value in both themes', () => {
    for (const consumer of manifest.consumers) {
      expect(lightTokens[consumer.foregroundToken], `light --${consumer.foregroundToken} undefined`).toBeDefined()
      expect(lightTokens[consumer.backgroundToken], `light --${consumer.backgroundToken} undefined`).toBeDefined()
      expect(darkTokens[consumer.foregroundToken], `dark --${consumer.foregroundToken} undefined`).toBeDefined()
      expect(darkTokens[consumer.backgroundToken], `dark --${consumer.backgroundToken} undefined`).toBeDefined()
    }
  })

  test('every consumer pair contrast ratio is >= 4.5 in light and dark theme', () => {
    for (const consumer of manifest.consumers) {
      const ratioLight = contrastRatio(lightTokens[consumer.foregroundToken]!, lightTokens[consumer.backgroundToken]!)
      const ratioDark = contrastRatio(darkTokens[consumer.foregroundToken]!, darkTokens[consumer.backgroundToken]!)
      expect(ratioLight, `${consumer.id} light ratio ${ratioLight.toFixed(3)} < 4.5`).toBeGreaterThanOrEqual(4.5)
      expect(ratioDark, `${consumer.id} dark ratio ${ratioDark.toFixed(3)} < 4.5`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// ---------------------------------------------------------------------------
// Bidirectional enumeration (§5.2/§7.2 J2): manifest→real (every declared
// consumer is actually reachable in its named fixture's rendered HTML) and
// real→manifest (every reachable selector/state across every fixture of a
// page is declared as a consumer — no missing, no stale entries).
// ---------------------------------------------------------------------------

describe('ui contrast manifest — bidirectional consumer enumeration', () => {
  const fixtureHtml = new Map(manifest.fixtureMatrix.map((f) => [f.id, renderFixture(f)]))

  test('manifest -> real: every declared consumer selector/state is reachable in its named fixture', () => {
    for (const consumer of manifest.consumers) {
      const html = fixtureHtml.get(consumer.fixture)!
      const detect = SELECTOR_DETECTORS[consumer.selector]
      expect(detect, `no detector registered for selector ${consumer.selector}`).toBeDefined()
      expect(detect(html), `${consumer.id}: selector ${consumer.selector} not reachable in fixture ${consumer.fixture}`).toBe(true)
      if (consumer.state === 'focus-visible') {
        expect(
          FOCUSABLE_SELECTORS.has(consumer.selector),
          `${consumer.id}: selector ${consumer.selector} is not an inherently focusable element`
        ).toBe(true)
      }
    }
  })

  test('real -> manifest: every reachable selector (and focus-visible variant) in every fixture is declared', () => {
    const htmlByPage = new Map<Page, string[]>()
    for (const fixture of manifest.fixtureMatrix) {
      const list = htmlByPage.get(fixture.page) ?? []
      list.push(fixtureHtml.get(fixture.id)!)
      htmlByPage.set(fixture.page, list)
    }
    const declaredKey = (page: Page, selector: string, state: ConsumerState) => `${page}::${selector}::${state}`
    const declared = new Set(manifest.consumers.map((c) => declaredKey(c.page, c.selector, c.state)))
    for (const [page, htmls] of htmlByPage) {
      for (const [selector, detect] of Object.entries(SELECTOR_DETECTORS)) {
        const reachable = htmls.some((html) => detect(html))
        if (!reachable) continue
        expect(
          declared.has(declaredKey(page, selector, 'default')),
          `${page}: missing consumer for reachable selector ${selector} (default)`
        ).toBe(true)
        if (FOCUSABLE_SELECTORS.has(selector)) {
          expect(
            declared.has(declaredKey(page, selector, 'focus-visible')),
            `${page}: missing consumer for reachable focusable selector ${selector} (focus-visible)`
          ).toBe(true)
        }
      }
    }
  })
})
