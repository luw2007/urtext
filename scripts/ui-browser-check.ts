#!/usr/bin/env node
/**
 * I3 Chrome CDP/AX browser check (urtext-20260724-ui-redesign §7.2 I3, §8.3,
 * §5.1, §5.2).
 *
 * Attaches to an *explicit* remote-debugging port and profile the caller has
 * already launched (see `ui-browser-check-wrapper.mjs`) — this module never
 * spawns or discovers Chrome itself, so every run is traceable to one
 * intentional debug target. Zero dependencies: CDP transport uses Node's
 * built-in `WebSocket`/`fetch` (Node >= 22).
 *
 * Exported pure validators and DOM/AX extractors are the unit-testable
 * surface — extractors take an injected `CdpClient` so Vitest can prove real
 * wiring (and injected failures) without a live browser. `createCdpClient`
 * and the CLI entry point are the only pieces that require a real Chrome and
 * are exercised by the trusted final gate, not this slice's Vitest run.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VIEWPORTS = [1440, 1024, 390] as const
export type Viewport = (typeof VIEWPORTS)[number]

export const COLOR_SCHEMES = ['light', 'dark'] as const
export type ColorScheme = (typeof COLOR_SCHEMES)[number]

const CONTRAST_THRESHOLD = 4.5

// ---------------------------------------------------------------------------
// Contrast (WCAG 2.1 relative luminance / contrast ratio)
// ---------------------------------------------------------------------------

const srgbChannel = (c: number): number => {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m?.[1]) throw new Error(`invalid hex color ${JSON.stringify(hex)}`)
  const value = m[1]
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
}

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
}

/** WCAG contrast ratio between two hex colors (order-independent), 1..21. */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la]
  return (lighter + 0.05) / (darker + 0.05)
}

/** Converts a CSSOM `rgb(r, g, b)` / `rgba(r, g, b, a)` string (as returned by `getComputedStyle`) to `#rrggbb`. */
export const rgbStringToHex = (rgb: string): string => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(rgb)
  if (!m?.[1] || !m[2] || !m[3]) throw new Error(`unparseable computed color ${JSON.stringify(rgb)}`)
  const toHex = (n: string): string => Math.round(Number(n)).toString(16).padStart(2, '0')
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`
}

export interface ContrastPair {
  label: string
  fg: string
  bg: string
}

export interface ContrastResult {
  label: string
  ratio: number
  pass: boolean
}

/** Checks every pair against the AA text threshold (§5.2: all visible text pairs >= 4.5). */
export const checkContrastPairs = (pairs: ContrastPair[], threshold = CONTRAST_THRESHOLD): ContrastResult[] =>
  pairs.map(({ label, fg, bg }) => {
    const ratio = contrastRatio(fg, bg)
    return { label, ratio, pass: ratio >= threshold }
  })

// ---------------------------------------------------------------------------
// Landmarks / headings / AX labels / keyboard focus / overflow / motion
// ---------------------------------------------------------------------------

const REQUIRED_LANDMARKS = ['main', 'header', 'nav'] as const

/** Missing landmark roles from an observed set (§5.1). Empty = pass. */
export const missingLandmarks = (observed: string[]): string[] =>
  REQUIRED_LANDMARKS.filter((role) => !observed.includes(role))

export interface HeadingNode {
  level: number
  text: string
}

/** Structural heading errors: not starting at h1, more than one h1, or a skipped level (§5.1). */
export const validateHeadingOrder = (headings: HeadingNode[]): string[] => {
  const errors: string[] = []
  const h1Count = headings.filter((h) => h.level === 1).length
  if (h1Count !== 1) errors.push(`expected exactly one h1, found ${h1Count}`)
  if (headings[0] !== undefined && headings[0].level !== 1) errors.push('first heading must be h1')
  for (let i = 1; i < headings.length; i += 1) {
    const prev = headings[i - 1]!
    const cur = headings[i]!
    if (cur.level > prev.level + 1) errors.push(`heading level skipped: h${prev.level} -> h${cur.level} at "${cur.text}"`)
  }
  return errors
}

export interface AxNode {
  role: string
  name: string
  interactive: boolean
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox'])

/** Interactive AX nodes with no accessible name (§5.1 aria label contract). */
export const missingAxLabels = (nodes: AxNode[]): AxNode[] =>
  nodes.filter((n) => (n.interactive || INTERACTIVE_ROLES.has(n.role)) && n.name.trim().length === 0)

/** Keyboard focus order errors: skip link must be first, and `expectedFirst` after it must appear before any element not in `order`'s prefix (§5.1/§3.1 item 1). */
export const validateFocusOrder = (order: string[]): string[] => {
  const errors: string[] = []
  if (order[0] !== 'skip-link') errors.push(`first focusable element must be the skip link, got ${JSON.stringify(order[0])}`)
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id)) errors.push(`duplicate focus stop ${id}`)
    seen.add(id)
  }
  return errors
}

/** No horizontal overflow at a viewport (§5.3): scrollWidth must not exceed clientWidth. */
export const hasHorizontalOverflow = (scrollWidth: number, clientWidth: number): boolean => scrollWidth > clientWidth

/** `prefers-reduced-motion: reduce` must disable transitions/animations (§5.1). */
export const reducedMotionHonored = (computedTransition: string, computedAnimation: string): boolean =>
  computedTransition === 'none' && computedAnimation === 'none'

// ---------------------------------------------------------------------------
// Progressive disclosure / config thresholds / diff count
// ---------------------------------------------------------------------------

export interface DisclosureExpectation {
  id: string
  expectedOpen: boolean
}

/** Mismatches between observed `<details open>` state and the §3.1 item 7 / §3.2 item 5 disclosure contract. */
export const validateDisclosure = (observed: Record<string, boolean>, expectations: DisclosureExpectation[]): string[] =>
  expectations
    .filter(({ id, expectedOpen }) => observed[id] !== expectedOpen)
    .map(({ id, expectedOpen }) => `${id}: expected open=${expectedOpen}, got open=${String(observed[id])}`)

export interface RenderConfigLike {
  diffOpenMaxLines: number
  diffDisplayMaxLines: number
}

/** Config threshold sanity independent of `readUiRenderConfig` env parsing (§3.2 item 5): both positive, open <= display. */
export const validateConfigThresholds = (config: RenderConfigLike): string[] => {
  const errors: string[] = []
  if (!Number.isInteger(config.diffOpenMaxLines) || config.diffOpenMaxLines <= 0) errors.push('diffOpenMaxLines must be a positive integer')
  if (!Number.isInteger(config.diffDisplayMaxLines) || config.diffDisplayMaxLines <= 0) errors.push('diffDisplayMaxLines must be a positive integer')
  if (config.diffOpenMaxLines > config.diffDisplayMaxLines) errors.push('diffOpenMaxLines must not exceed diffDisplayMaxLines')
  return errors
}

const REAL_DIFF_COUNT = 5

/** The C004 fixture brief must render exactly five real mapping diffs (§8.2 item 1, plan §1 evidence baseline). */
export const validateRealDiffCount = (diffIds: string[], expected = REAL_DIFF_COUNT): boolean => diffIds.length === expected

// ---------------------------------------------------------------------------
// HTTP guard cases
// ---------------------------------------------------------------------------

export interface HttpGuardCase {
  name: string
  method: 'GET' | 'POST'
  path: string
  headers: Record<string, string>
  expectedStatus: number
}

/** The route-guard matrix I1 closed and I3 must observe live over CDP `fetch`: bad Host, wrong media type, oversized body, missing CSRF/Origin on writes. */
export const HTTP_GUARD_CASES: HttpGuardCase[] = [
  { name: 'bad-host-get', method: 'GET', path: '/', headers: { Host: 'evil.example' }, expectedStatus: 400 },
  { name: 'wrong-media-type-post', method: 'POST', path: '/decide', headers: { 'Content-Type': 'text/plain' }, expectedStatus: 415 },
  { name: 'missing-csrf-post', method: 'POST', path: '/decide', headers: { 'Content-Type': 'application/json' }, expectedStatus: 403 },
  { name: 'missing-origin-post', method: 'POST', path: '/decide', headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': 'x' }, expectedStatus: 403 },
]

/** A guard case passes iff the observed status matches the case's expectation exactly. */
export const evaluateHttpGuardCase = (guardCase: HttpGuardCase, observedStatus: number): boolean =>
  observedStatus === guardCase.expectedStatus

/** Sends one guard case against `baseUrl`'s origin+port and evaluates the observed status (§5.1 Host/media/CSRF/Origin route guards, observed live not simulated). */
export const runHttpGuardCase = async (baseUrl: string, guardCase: HttpGuardCase): Promise<{ name: string; pass: boolean; status: number }> => {
  const res = await fetch(new URL(guardCase.path, baseUrl).href, { method: guardCase.method, headers: guardCase.headers })
  return { name: guardCase.name, status: res.status, pass: evaluateHttpGuardCase(guardCase, res.status) }
}

// ---------------------------------------------------------------------------
// Request-record sanitization (§8.3.2 deny list — never persist raw argv/prompt/credential bytes)
// ---------------------------------------------------------------------------

const DENY_KEYS = new Set(['args', 'argv', 'prompt', 'csrf', 'authorization', 'cookie', 'credential', 'profile', 'model'])
const REDACTED = '[REDACTED]'

/** Recursively redacts deny-listed keys (case-insensitive) from a plain JSON-like request record before it may be persisted to a transcript. */
export const sanitizeRequestRecord = (record: unknown): unknown => {
  if (Array.isArray(record)) return record.map(sanitizeRequestRecord)
  if (record !== null && typeof record === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      out[key] = DENY_KEYS.has(key.toLowerCase()) ? REDACTED : sanitizeRequestRecord(value)
    }
    return out
  }
  return record
}

// ---------------------------------------------------------------------------
// CDP transport — real WebSocket implementation, plus the injectable
// interface every extractor below is written against so Vitest can prove
// real wiring with a fake client.
// ---------------------------------------------------------------------------

export interface CdpClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>
  close: () => void
}

interface CdpTargetInfo {
  id: string
  webSocketDebuggerUrl: string
}

const cdpConnectTarget = async (port: number): Promise<CdpTargetInfo> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`CDP /json/new failed: ${res.status}`)
  return (await res.json()) as CdpTargetInfo
}

/** Opens a fresh CDP target on `port` and returns a real WebSocket-backed `CdpClient`. Not exercised by Vitest — needs a live Chrome. */
export const createCdpClient = async (port: number): Promise<CdpClient> => {
  const target = await cdpConnectTarget(port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const opened = Promise.withResolvers<void>()
  ws.addEventListener('open', () => opened.resolve())
  ws.addEventListener('error', () => opened.reject(new Error('CDP websocket connect failed')))
  await opened.promise

  let messageId = 0
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const { promise, resolve, reject } = Promise.withResolvers<any>()
    const id = (messageId += 1)
    const onMessage = (event: MessageEvent): void => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
    return promise
  }

  return { send, close: () => ws.close() }
}

// ---------------------------------------------------------------------------
// Live page extractors — each is a thin, unit-testable wrapper around one or
// two CDP calls against an injected client. None hardcodes a result: every
// returned value is parsed from the client's `send()` response.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Polls `document.readyState` via the injected client until `complete`, or throws after `timeoutMs`. */
export const waitForPageLoad = async (client: CdpClient, timeoutMs = 10_000, pollMs = 50): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (res.result.value === 'complete') return
    if (Date.now() > deadline) throw new Error(`page load timed out after ${timeoutMs}ms`)
    await sleep(pollMs)
  }
}

/** Real `<h1>`..`<h6>` DOM order, parsed from the injected client's response. */
export const extractHeadings = async (client: CdpClient): Promise<HeadingNode[]> => {
  const res = await client.send('Runtime.evaluate', {
    expression:
      'JSON.stringify([...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(e=>({level:Number(e.tagName[1]),text:e.textContent.trim()})))',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as HeadingNode[]
}

/** Real landmark tag names present in the DOM, parsed from the injected client's response. */
export const extractLandmarks = async (client: CdpClient): Promise<string[]> => {
  const res = await client.send('Runtime.evaluate', {
    expression: 'JSON.stringify([...document.querySelectorAll("main,header,nav")].map(e=>e.tagName.toLowerCase()))',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as string[]
}

/** Real `document.documentElement` overflow dimensions, parsed from the injected client's response. */
export const extractOverflow = async (client: CdpClient): Promise<{ scrollWidth: number; clientWidth: number }> => {
  const res = await client.send('Runtime.evaluate', {
    expression: 'JSON.stringify({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth})',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as { scrollWidth: number; clientWidth: number }
}

/** Real computed `transition-property`/`animation-name` on `<body>` (§5.1 reduced-motion CSS applies `*{}`), parsed from the injected client's response. */
export const extractReducedMotion = async (client: CdpClient): Promise<{ transition: string; animation: string }> => {
  const res = await client.send('Runtime.evaluate', {
    expression:
      'JSON.stringify((()=>{const s=getComputedStyle(document.body);return {transition:s.transitionProperty,animation:s.animationName}})())',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as { transition: string; animation: string }
}

/** Real `<details data-section>` open/closed state, keyed by `data-section`, parsed from the injected client's response. */
export const extractDisclosureState = async (client: CdpClient): Promise<Record<string, boolean>> => {
  const res = await client.send('Runtime.evaluate', {
    expression: 'JSON.stringify(Object.fromEntries([...document.querySelectorAll("details[data-section]")].map(e=>[e.dataset.section,e.open])))',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as Record<string, boolean>
}

/** Real `[data-section="blame-diff"]` diff block ids, parsed from the injected client's response. */
export const extractDiffIds = async (client: CdpClient): Promise<string[]> => {
  const res = await client.send('Runtime.evaluate', {
    expression:
      'JSON.stringify([...document.querySelectorAll(\'[data-section="blame-diff"]\')].map((e,i)=>e.querySelector("summary")?.id||String(i)))',
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as string[]
}

/** Real accessible-name AX nodes from `Accessibility.getFullAXTree`, filtered to non-ignored nodes. */
export const extractAxNodes = async (client: CdpClient): Promise<AxNode[]> => {
  const res = await client.send('Accessibility.getFullAXTree', {})
  const nodes = (res.nodes ?? []) as { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[]
  return nodes
    .filter((n) => n.ignored !== true)
    .map((n) => {
      const role = n.role?.value ?? ''
      return { role, name: n.name?.value ?? '', interactive: INTERACTIVE_ROLES.has(role) }
    })
}

/** Drives real keyboard `Tab` presses via `Input.dispatchKeyEvent` and reads `document.activeElement` after each, mapping the skip-link anchor to `"skip-link"`. */
export const captureFocusOrder = async (client: CdpClient, steps: number): Promise<string[]> => {
  const order: string[] = []
  for (let i = 0; i < steps; i += 1) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    const res = await client.send('Runtime.evaluate', {
      expression:
        '(()=>{const e=document.activeElement;if(!e||e===document.body)return "";if(e.classList&&e.classList.contains("skip"))return "skip-link";return e.id||e.tagName.toLowerCase();})()',
      returnByValue: true,
    })
    const id = String(res.result.value)
    if (id !== '') order.push(id)
  }
  return order
}

const CONTRAST_EXTRACTION_EXPRESSION = `JSON.stringify([...document.querySelectorAll('body *')]
  .filter(e=>e.children.length===0 && e.textContent && e.textContent.trim().length>0)
  .map((e,i)=>{
    let bgEl=e; let bg='rgb(255, 255, 255)';
    while(bgEl){ const c=getComputedStyle(bgEl).backgroundColor; if(c && c!=='rgba(0, 0, 0, 0)' && c!=='transparent'){ bg=c; break; } bgEl=bgEl.parentElement; }
    return { label:(e.id||e.tagName.toLowerCase()+'-'+i), fg:getComputedStyle(e).color, bg };
  }))`

/** Real leaf-text-node foreground/background computed colors (walking ancestors for the nearest opaque background), converted from `rgb()` to hex. */
export const extractContrastPairs = async (client: CdpClient): Promise<ContrastPair[]> => {
  const res = await client.send('Runtime.evaluate', { expression: CONTRAST_EXTRACTION_EXPRESSION, returnByValue: true })
  const raw = JSON.parse(res.result.value) as { label: string; fg: string; bg: string }[]
  return raw.map(({ label, fg, bg }) => ({ label, fg: rgbStringToHex(fg), bg: rgbStringToHex(bg) }))
}

// ---------------------------------------------------------------------------
// Aggregate one page/viewport/color-scheme run into a scored summary
// ---------------------------------------------------------------------------

export interface CheckSummary {
  page: string
  viewport: number
  colorScheme: ColorScheme
  contrast: ContrastResult[]
  landmarkErrors: string[]
  headingErrors: string[]
  axLabelErrors: AxNode[]
  focusErrors: string[]
  horizontalOverflow: boolean
  reducedMotionOk: boolean
  disclosureErrors: string[]
  realDiffCount: boolean
  guardResults: { name: string; pass: boolean }[]
}

export interface RunCheckConfig {
  focusSteps: number
  expectedDiffCount: number
  disclosureExpectations: DisclosureExpectation[]
  guardCases: HttpGuardCase[]
}

/**
 * Runs the full validation matrix once, against an already-navigated,
 * already-load-waited CDP target at `viewport`/`colorScheme`. Every field is
 * parsed from a live extractor call against `client` (or, for HTTP guard
 * checks, a real `fetch` against `baseUrl`) — nothing here is a fixed
 * placeholder.
 */
export const runCheckAtViewport = async (
  client: CdpClient,
  baseUrl: string,
  page: string,
  viewport: number,
  colorScheme: ColorScheme,
  config: RunCheckConfig,
): Promise<CheckSummary> => {
  const [landmarks, headings, axNodes, overflow, motion, disclosure, diffIds, contrastPairs, focusOrder] = await Promise.all([
    extractLandmarks(client),
    extractHeadings(client),
    extractAxNodes(client),
    extractOverflow(client),
    extractReducedMotion(client),
    extractDisclosureState(client),
    extractDiffIds(client),
    extractContrastPairs(client),
    captureFocusOrder(client, config.focusSteps),
  ])

  const guardResults = await Promise.all(config.guardCases.map((c) => runHttpGuardCase(baseUrl, c)))

  return {
    page,
    viewport,
    colorScheme,
    contrast: checkContrastPairs(contrastPairs),
    landmarkErrors: missingLandmarks(landmarks),
    headingErrors: validateHeadingOrder(headings),
    axLabelErrors: missingAxLabels(axNodes),
    focusErrors: validateFocusOrder(focusOrder),
    horizontalOverflow: hasHorizontalOverflow(overflow.scrollWidth, overflow.clientWidth),
    reducedMotionOk: reducedMotionHonored(motion.transition, motion.animation),
    disclosureErrors: validateDisclosure(disclosure, config.disclosureExpectations),
    realDiffCount: validateRealDiffCount(diffIds, config.expectedDiffCount),
    guardResults: guardResults.map(({ name, pass }) => ({ name, pass })),
  }
}

export interface Assertion {
  name: string
  expected: unknown
  actual: unknown
  pass: boolean
}

/** Flattens one `CheckSummary` into individually-named expected/actual/pass assertions — the external-evidence unit of truth. */
export const buildAssertions = (summary: CheckSummary): Assertion[] => {
  const prefix = `${summary.page}@${summary.viewport}/${summary.colorScheme}`
  return [
    { name: `${prefix}:landmarks`, expected: [], actual: summary.landmarkErrors, pass: summary.landmarkErrors.length === 0 },
    { name: `${prefix}:headings`, expected: [], actual: summary.headingErrors, pass: summary.headingErrors.length === 0 },
    { name: `${prefix}:ax-labels`, expected: [], actual: summary.axLabelErrors, pass: summary.axLabelErrors.length === 0 },
    { name: `${prefix}:focus-order`, expected: [], actual: summary.focusErrors, pass: summary.focusErrors.length === 0 },
    { name: `${prefix}:no-horizontal-overflow`, expected: false, actual: summary.horizontalOverflow, pass: !summary.horizontalOverflow },
    { name: `${prefix}:reduced-motion`, expected: true, actual: summary.reducedMotionOk, pass: summary.reducedMotionOk },
    { name: `${prefix}:disclosure`, expected: [], actual: summary.disclosureErrors, pass: summary.disclosureErrors.length === 0 },
    { name: `${prefix}:real-diff-count`, expected: true, actual: summary.realDiffCount, pass: summary.realDiffCount },
    ...summary.contrast.map((c) => ({ name: `${prefix}:contrast:${c.label}`, expected: true, actual: c.pass, pass: c.pass })),
    ...summary.guardResults.map((g) => ({ name: `${prefix}:guard:${g.name}`, expected: true, actual: g.pass, pass: g.pass })),
  ]
}

/** 0 iff every assertion across every summary passed; 1 otherwise (§8.3: no fixed pass placeholders, real failures must fail the run). */
export const computeExitCode = (summaries: CheckSummary[]): number =>
  summaries.every((s) => buildAssertions(s).every((a) => a.pass)) ? 0 : 1

// ---------------------------------------------------------------------------
// CLI entry point — real Chrome only, excluded from Vitest
// ---------------------------------------------------------------------------

const isMain = (): boolean => process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain()) {
  const args = process.argv.slice(2)
  const readArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx === -1 ? undefined : args[idx + 1]
  }
  const readAllArgs = (flag: string): string[] => {
    const out: string[] = []
    args.forEach((a, i) => {
      if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]!)
    })
    return out
  }
  const splitKv = (raw: string, valueParser: (v: string) => unknown = (v) => v): [string, unknown] => {
    const eq = raw.indexOf('=')
    if (eq === -1) throw new Error(`expected key=value, got ${JSON.stringify(raw)}`)
    return [raw.slice(0, eq), valueParser(raw.slice(eq + 1))]
  }

  const portRaw = readArg('--port')
  const profileDir = readArg('--profile')
  const pageArgs = readAllArgs('--page')
  const outputDir = readArg('--output-dir')
  const focusSteps = Number(readArg('--focus-steps') ?? '8')
  const expectedDiffCount = Number(readArg('--diff-count') ?? '5')
  const disclosureExpectations: DisclosureExpectation[] = readAllArgs('--disclosure').map((raw) => {
    const [id, expectedOpen] = splitKv(raw, (v) => v === 'true')
    return { id, expectedOpen: expectedOpen as boolean }
  })

  if (portRaw === undefined || profileDir === undefined || pageArgs.length === 0) {
    process.stderr.write('usage: ui-browser-check.js --port <n> --profile <dir> --page <name>=<url> [--page <name>=<url> ...] [--output-dir <dir>] [--focus-steps <n>] [--diff-count <n>] [--disclosure <id>=<true|false>]\n')
    process.exit(2)
  }

  const pages = pageArgs.map((raw) => {
    const [name, url] = splitKv(raw)
    return { name, url: url as string }
  })

  const port = Number(portRaw)
  const config: RunCheckConfig = { focusSteps, expectedDiffCount, disclosureExpectations, guardCases: HTTP_GUARD_CASES }

  const summaries: CheckSummary[] = []
  for (const { name: pageName, url } of pages) {
    for (const viewport of VIEWPORTS) {
      for (const colorScheme of COLOR_SCHEMES) {
        const client = await createCdpClient(port)
        try {
          await client.send('Page.enable')
          await client.send('DOM.enable')
          await client.send('Runtime.enable')
          await client.send('Accessibility.enable')
          await client.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: viewport <= 390 })
          await client.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-reduced-motion', value: 'reduce' },
              { name: 'prefers-color-scheme', value: colorScheme },
            ],
          })
          await client.send('Page.navigate', { url })
          await waitForPageLoad(client)
          const summary = await runCheckAtViewport(client, url, pageName, viewport, colorScheme, config)
          summaries.push(summary)
          if (outputDir !== undefined) {
            const shot = (await client.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
            mkdirSync(outputDir, { recursive: true })
            const base = `${pageName}-${viewport}-${colorScheme}`
            writeFileSync(join(outputDir, `${base}.png`), Buffer.from(shot.data, 'base64'))
          }
        } finally {
          client.close()
        }
      }
    }
  }

  const report = {
    summaries,
    assertions: summaries.flatMap(buildAssertions),
  }
  const sanitized = sanitizeRequestRecord(report)
  process.stdout.write(`${JSON.stringify(sanitized)}\n`)
  if (outputDir !== undefined) {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'ui-browser-check-report.json'), JSON.stringify(sanitized, null, 2))
  }
  process.exit(computeExitCode(summaries))
}
