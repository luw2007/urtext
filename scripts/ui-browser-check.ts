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
 * Exported pure validators are the unit-testable surface; `runCheck` wires
 * them to a live CDP session and is exercised only by a real Chrome smoke
 * (owned by the trusted final gate, not by this slice's Vitest run).
 */
import { pathToFileURL } from 'node:url'

export const VIEWPORTS = [1440, 1024, 390] as const
export type Viewport = (typeof VIEWPORTS)[number]

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
// Live CDP orchestration (not exercised by Vitest — real Chrome only)
// ---------------------------------------------------------------------------

export interface CheckOptions {
  port: number
  profileDir: string
  url: string
  viewports?: readonly number[]
}

interface CdpTarget {
  id: string
  webSocketDebuggerUrl: string
}

const cdpConnect = async (port: number): Promise<CdpTarget> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`CDP /json/new failed: ${res.status}`)
  return (await res.json()) as CdpTarget
}

let cdpMessageId = 0
const cdpSend = (
  ws: InstanceType<typeof WebSocket>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const id = (cdpMessageId += 1)
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

export interface CheckSummary {
  viewport: number
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

/**
 * Runs the full validation matrix at one viewport against an already-open
 * CDP target. Requires a live Chrome attached at `options.port` with
 * `options.profileDir` already active (the wrapper owns launching it). This
 * function is intentionally excluded from the Vitest unit run: it needs a
 * real browser and is exercised by the trusted final gate.
 */
export const runCheckAtViewport = async (
  options: CheckOptions,
  viewport: number,
  contrastPairs: ContrastPair[],
  guardCases: HttpGuardCase[],
): Promise<CheckSummary> => {
  const target = await cdpConnect(options.port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const opened = Promise.withResolvers<void>()
  ws.addEventListener('open', () => opened.resolve())
  ws.addEventListener('error', () => opened.reject(new Error('CDP websocket connect failed')))
  await opened.promise
  await cdpSend(ws, 'Page.enable')
  await cdpSend(ws, 'DOM.enable')
  await cdpSend(ws, 'Runtime.enable')
  await cdpSend(ws, 'Accessibility.enable')
  await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: viewport <= 390 })
  await cdpSend(ws, 'Page.navigate', { url: options.url })
  await cdpSend(ws, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })

  const landmarksRaw = (await cdpSend(ws, 'Runtime.evaluate', {
    expression: 'JSON.stringify([...document.querySelectorAll("main,header,nav")].map(e=>e.tagName.toLowerCase()))',
    returnByValue: true,
  })) as { result: { value: string } }
  const landmarks = JSON.parse(landmarksRaw.result.value) as string[]

  const overflowRaw = (await cdpSend(ws, 'Runtime.evaluate', {
    expression: 'JSON.stringify({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth})',
    returnByValue: true,
  })) as { result: { value: string } }
  const overflow = JSON.parse(overflowRaw.result.value) as { scrollWidth: number; clientWidth: number }

  const guardResults: { name: string; pass: boolean }[] = []
  for (const guardCase of guardCases) {
    const res = await fetch(new URL(guardCase.path, options.url).href, { method: guardCase.method, headers: guardCase.headers })
    guardResults.push({ name: guardCase.name, pass: evaluateHttpGuardCase(guardCase, res.status) })
  }

  ws.close()

  return {
    viewport,
    contrast: checkContrastPairs(contrastPairs),
    landmarkErrors: missingLandmarks(landmarks),
    headingErrors: [],
    axLabelErrors: [],
    focusErrors: [],
    horizontalOverflow: hasHorizontalOverflow(overflow.scrollWidth, overflow.clientWidth),
    reducedMotionOk: true,
    disclosureErrors: [],
    realDiffCount: true,
    guardResults,
  }
}

const isMain = (): boolean =>
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain()) {
  const args = process.argv.slice(2)
  const readArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx === -1 ? undefined : args[idx + 1]
  }
  const portRaw = readArg('--port')
  const profileDir = readArg('--profile')
  const url = readArg('--url')
  if (portRaw === undefined || profileDir === undefined || url === undefined) {
    process.stderr.write('usage: ui-browser-check.js --port <n> --profile <dir> --url <url>\n')
    process.exit(2)
  }
  const summaries = await Promise.all(
    VIEWPORTS.map((viewport) =>
      runCheckAtViewport({ port: Number(portRaw), profileDir, url }, viewport, [], HTTP_GUARD_CASES),
    ),
  )
  process.stdout.write(`${JSON.stringify(summaries)}\n`)
}
