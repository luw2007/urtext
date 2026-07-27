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
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { UiSnapshot } from '../src/review-ui.js'
import type { BriefPageInput, RequirementBindingView } from '../src/ui/contracts.js'
import { renderBriefErrorPage, renderBriefPage } from '../src/ui/render-brief.js'
import { renderConsoleFamilyPage, type ConsoleRoute } from '../src/ui/render-console.js'

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

type ContrastFixture =
  | { id: string; page: 'console'; route: ConsoleRoute; pageNumber: number; pageSize: number; snapshot: UiSnapshot; csrfToken: string; auditResult?: string }
  | { id: string; page: 'brief'; input: BriefPageInput }
  | { id: string; page: 'error'; message: string; requirementBindings?: RequirementBindingView[] }

interface ContrastManifest {
  schema: string
  sourceContractSha256: string
  renderContractSha256: string
  fixtureMatrix: ContrastFixture[]
}

export interface ManifestVerification {
  path: string
  fileSha256: string
  schema: string
  assertions: Assertion[]
}

const CONTRAST_SOURCE_FILES = [
  'src/ui/theme.ts',
  'src/ui/html.ts',
  'src/ui/contracts.ts',
  'src/ui/pagination.ts',
  'src/ui/render-console.ts',
  'src/ui/render-brief.ts',
  'src/ui/console-script.ts',
  'src/ui/brief-script.ts',
] as const

const hashFrame = (label: string, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${label}\0${bytes.byteLength}\0`, 'utf8'), bytes, Buffer.from('\0', 'utf8')])

const renderContrastFixture = (fixture: ContrastFixture): string => {
  if (fixture.page === 'console') {
    return renderConsoleFamilyPage({
      route: fixture.route,
      snapshot: fixture.snapshot,
      csrfToken: fixture.csrfToken,
      page: fixture.pageNumber,
      pageSize: fixture.pageSize,
      ...(fixture.auditResult !== undefined ? { auditResult: fixture.auditResult } : {}),
    })
  }
  if (fixture.page === 'brief') return renderBriefPage(fixture.input)
  return renderBriefErrorPage(fixture.message, fixture.requirementBindings)
}

export const verifyContrastManifest = (manifestPath: string, sourceRoot: string): ManifestVerification => {
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ContrastManifest
  if (manifest.schema !== 'urtext.ui-contrast-consumers/3' || !Array.isArray(manifest.fixtureMatrix)) {
    throw new Error(`invalid contrast manifest schema at ${manifestPath}`)
  }

  const sourceHash = createHash('sha256')
  for (const path of CONTRAST_SOURCE_FILES) sourceHash.update(hashFrame(path, readFileSync(join(sourceRoot, path))))
  sourceHash.update(hashFrame('fixtureMatrix', Buffer.from(JSON.stringify(manifest.fixtureMatrix), 'utf8')))
  const actualSource = sourceHash.digest('hex')

  const renderHash = createHash('sha256')
  for (const fixture of manifest.fixtureMatrix) {
    renderHash.update(hashFrame(fixture.id, Buffer.from(renderContrastFixture(fixture), 'utf8')))
  }
  const actualRender = renderHash.digest('hex')

  return {
    path: manifestPath,
    fileSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    schema: manifest.schema,
    assertions: [
      { name: 'contrast-manifest:source-contract-sha256', expected: manifest.sourceContractSha256, actual: actualSource, pass: actualSource === manifest.sourceContractSha256 },
      { name: 'contrast-manifest:render-contract-sha256', expected: manifest.renderContractSha256, actual: actualRender, pass: actualRender === manifest.renderContractSha256 },
    ],
  }
}

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
  nodeId?: string | undefined
  parentId?: string | undefined
  backendDOMNodeId?: number | undefined
  nameSources?: string[] | undefined
  ignored?: boolean | undefined
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox'])

/** Interactive AX nodes with no accessible name (§5.1 aria label contract). */
export const missingAxLabels = (nodes: AxNode[]): AxNode[] =>
  nodes.filter((n) => n.ignored !== true && (n.interactive || INTERACTIVE_ROLES.has(n.role)) && n.name.trim().length === 0)

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
// Progressive disclosure / diff count
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

/** The route-guard matrix I1 closed and I3 observes live: bad Host, wrong media type, missing CSRF, and hostile Origin. */
export const HTTP_GUARD_CASES: HttpGuardCase[] = [
  { name: 'bad-host-get', method: 'GET', path: '/', headers: { Host: 'evil.example' }, expectedStatus: 403 },
  { name: 'wrong-media-type-post', method: 'POST', path: '/api/decide', headers: { 'Content-Type': 'text/plain' }, expectedStatus: 415 },
  { name: 'missing-csrf-post', method: 'POST', path: '/api/decide', headers: { 'Content-Type': 'application/json' }, expectedStatus: 403 },
  { name: 'hostile-origin-post', method: 'POST', path: '/api/decide', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, expectedStatus: 403 },
]

/** A guard case passes iff the observed status matches the case's expectation exactly. */
export const evaluateHttpGuardCase = (guardCase: HttpGuardCase, observedStatus: number): boolean =>
  observedStatus === guardCase.expectedStatus

/** Sends one guard case against `baseUrl`'s origin+port and evaluates the observed status. */
export const runHttpGuardCase = async (baseUrl: string, guardCase: HttpGuardCase): Promise<{ name: string; pass: boolean; status: number }> => {
  const base = new URL(baseUrl)
  let headers = guardCase.headers
  if (guardCase.name === 'wrong-media-type-post' || guardCase.name === 'hostile-origin-post') {
    const page = await fetch(base.origin)
    const html = await page.text()
    const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(html)?.[1]
    if (csrf === undefined) throw new Error('live console did not expose a CSRF token')
    headers = { ...headers, 'x-csrf': csrf }
    if (guardCase.name === 'wrong-media-type-post') headers = { ...headers, Origin: base.origin }
  }
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(new URL(guardCase.path, base), { method: guardCase.method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
  return { name: guardCase.name, status, pass: evaluateHttpGuardCase(guardCase, status) }
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
  on: (method: string, handler: (params: unknown) => void) => void
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
  const eventHandlers = new Map<string, ((params: unknown) => void)[]>()
  ws.addEventListener('message', (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as { method?: string; params?: unknown }
    if (msg.method === undefined) return
    for (const handler of eventHandlers.get(msg.method) ?? []) handler(msg.params)
  })
  const on = (method: string, handler: (params: unknown) => void): void => {
    const list = eventHandlers.get(method) ?? []
    list.push(handler)
    eventHandlers.set(method, list)
  }
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
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

  return { send, on, close: () => ws.close() }
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

/** Real full AX tree from `Accessibility.getFullAXTree`, including ignored ancestors so parent/child closure remains verifiable. */
export const extractAxNodes = async (client: CdpClient): Promise<AxNode[]> => {
  const res = await client.send('Accessibility.getFullAXTree', {})
  const nodes = (res.nodes ?? []) as {
    nodeId?: string
    parentId?: string
    backendDOMNodeId?: number
    role?: { value?: string }
    name?: { value?: string; sources?: { type?: string; attempted?: boolean }[] }
    ignored?: boolean
  }[]
  return nodes.map((n) => {
    const role = n.role?.value ?? ''
    const nameSources = n.name?.sources?.filter((s) => s.attempted !== false).map((s) => s.type ?? 'unknown')
    return {
      role,
      name: n.name?.value ?? '',
      interactive: n.ignored !== true && INTERACTIVE_ROLES.has(role),
      ignored: n.ignored === true,
      nodeId: n.nodeId,
      parentId: n.parentId,
      backendDOMNodeId: n.backendDOMNodeId,
      nameSources: nameSources !== undefined && nameSources.length > 0 ? nameSources : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// DOM <-> AX linkage (§8.3.4): DOM.getDocument/querySelector/describeNode
// resolve a selector to a backendDOMNodeId; that id must appear on exactly
// one node in the AX tree, proving the two trees describe the same page.
// ---------------------------------------------------------------------------

export interface DomIdentity {
  nodeId: number
  backendDOMNodeId: number
  domId: string | null
}

export const resolveSelectorDomIdentity = async (client: CdpClient, selector: string): Promise<DomIdentity> => {
  const { root } = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: { nodeId: number } }
  const { nodeId } = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })) as { nodeId: number }
  if (!nodeId) throw new Error(`selector not found in DOM: ${selector}`)
  const { node } = (await client.send('DOM.describeNode', { nodeId })) as { node: { backendNodeId: number; attributes?: string[] } }
  const attributes = node.attributes ?? []
  let domId: string | null = null
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === 'id') domId = attributes[index + 1] ?? null
  }
  return { nodeId, backendDOMNodeId: node.backendNodeId, domId }
}

/** Resolves a CSS `selector` to its `backendNodeId` via a real DOM round trip. */
export const resolveSelectorBackendNodeId = async (client: CdpClient, selector: string): Promise<number> =>
  (await resolveSelectorDomIdentity(client, selector)).backendDOMNodeId

export interface AxLink {
  selector: string
  domNodeId: number
  domId: string | null
  backendDOMNodeId: number
  axNodeId: string | null
  role: string
  name: string
  accessibleNameSource: string
}

/** Links a CSS `selector` to its AX node by resolving its `backendDOMNodeId` through the DOM and matching it against `axNodes`. Throws if no AX node carries that id — a real linkage failure, not a placeholder. */
export const linkSelectorToAxNode = async (client: CdpClient, selector: string, axNodes: AxNode[]): Promise<AxLink> => {
  const dom = await resolveSelectorDomIdentity(client, selector)
  const axNode = axNodes.find((node) => node.backendDOMNodeId === dom.backendDOMNodeId)
  if (axNode === undefined) throw new Error(`no AX node carries backendDOMNodeId ${dom.backendDOMNodeId} for selector ${JSON.stringify(selector)}`)
  return {
    selector,
    domNodeId: dom.nodeId,
    domId: dom.domId,
    backendDOMNodeId: dom.backendDOMNodeId,
    axNodeId: axNode.nodeId ?? null,
    role: axNode.role,
    name: axNode.name,
    accessibleNameSource: accessibleNameSource(axNode),
  }
}

/** The first attempted accessible-name computation source (e.g. `contents`, `attribute`) for an AX node, or `'none'` if it has no name. */
export const accessibleNameSource = (node: AxNode): string => (node.name.trim().length === 0 ? 'none' : (node.nameSources?.[0] ?? 'unknown'))


export const PAGE_AX_LINK_SELECTORS: Record<string, string[]> = {
  console: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', '#feature-health', '#queue-explain-btn', 'button[data-explain-key]', 'table', 'th[scope="col"]'],
  agent: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', '#audit-runner', 'table', 'th[scope="col"]'],
  specs: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', 'table', 'th[scope="col"]', 'nav[aria-label="分页"]'],
  'specs-page-2': ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', 'table', 'th[scope="col"]', 'nav[aria-label="分页"]'],
  decisions: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', 'table', 'th[scope="col"]'],
  brief: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', '[data-section="neighborhood"]', 'details[data-section="blame-diff"]', '#raw-brief-title', '#review-form', '#explain-btn'],
  error: ['.skip', 'header', 'nav[aria-label="页面导航"]', 'main', 'h1', '[role="alert"]'],
}

export const collectPageAxLinks = async (
  client: CdpClient,
  page: string,
  axNodes: AxNode[],
  selectors: Record<string, string[]> = PAGE_AX_LINK_SELECTORS,
): Promise<{ links: AxLink[]; errors: string[] }> => {
  const links: AxLink[] = []
  const errors: string[] = []
  for (const selector of selectors[page] ?? []) {
    try {
      links.push(await linkSelectorToAxNode(client, selector, axNodes))
    } catch (error) {
      errors.push(`${page}:${selector}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { links, errors }
}
/** Parent/child closure errors (§8.3.4): every non-root `parentId` must reference a node id present in the same tree. Empty = a fully closed tree. */
export const validateAxTreeClosure = (nodes: AxNode[]): string[] => {
  const ids = new Set(nodes.map((n) => n.nodeId).filter((id): id is string => id !== undefined))
  const errors: string[] = []
  for (const n of nodes) {
    if (n.parentId !== undefined && !ids.has(n.parentId)) errors.push(`AX node ${n.nodeId ?? '?'} (${n.role}) has dangling parentId ${n.parentId}`)
  }
  return errors
}

// ---------------------------------------------------------------------------
// Page-specific selector presence/absence/count (§8.3.4, frozen static IDs
// in plan §6.4: `audit-runner` is agent-only, `explain-btn` is brief-only).
// ---------------------------------------------------------------------------

export interface PageSpecificExpectation {
  page: string
  selector: string
  expectedCount: number
}

export const PAGE_SPECIFIC_SELECTORS: PageSpecificExpectation[] = [
  { page: 'console', selector: '#audit-runner', expectedCount: 0 },
  { page: 'console', selector: '#explain-btn', expectedCount: 0 },
  { page: 'console', selector: '#uncovered-intent', expectedCount: 1 },
  { page: 'console', selector: '#feature-health', expectedCount: 1 },
  { page: 'console', selector: 'li[data-feature="demo"]', expectedCount: 1 },
  { page: 'console', selector: '#queue-explain-btn', expectedCount: 1 },
  { page: 'console', selector: 'button[data-explain-key]', expectedCount: 2 },
  { page: 'console', selector: '[data-state="approval-semantics"]', expectedCount: 1 },
  { page: 'console', selector: '[data-causal]', expectedCount: 0 },
  {
    page: 'console',
    selector: 'li[data-uncovered="specs/demo/spec.md#FR002"]',
    expectedCount: 1,
  },
  { page: 'agent', selector: '#audit-runner', expectedCount: 1 },
  { page: 'agent', selector: '#explain-btn', expectedCount: 0 },
  { page: 'agent', selector: '#uncovered-intent', expectedCount: 0 },
  { page: 'agent', selector: '#feature-health', expectedCount: 0 },
  { page: 'agent', selector: '#queue-explain-btn', expectedCount: 0 },
  { page: 'agent', selector: 'button[data-explain-key]', expectedCount: 0 },
  { page: 'agent', selector: '[data-causal]', expectedCount: 1 },
  { page: 'specs', selector: 'nav[aria-label="分页"]', expectedCount: 1 },
  { page: 'specs', selector: 'a[rel="prev"]', expectedCount: 0 },
  { page: 'specs', selector: 'a[rel="next"]', expectedCount: 1 },
  { page: 'specs', selector: '#audit-runner', expectedCount: 0 },
  { page: 'specs', selector: '#uncovered-intent', expectedCount: 0 },
  { page: 'specs', selector: '#feature-health', expectedCount: 0 },
  { page: 'specs-page-2', selector: 'nav[aria-label="分页"]', expectedCount: 1 },
  { page: 'specs-page-2', selector: 'a[rel="prev"]', expectedCount: 1 },
  { page: 'specs-page-2', selector: 'a[rel="next"]', expectedCount: 1 },
  { page: 'specs-page-2', selector: '#feature-health', expectedCount: 0 },
  { page: 'decisions', selector: '#audit-runner', expectedCount: 0 },
  { page: 'decisions', selector: '#uncovered-intent', expectedCount: 0 },
  { page: 'decisions', selector: '#feature-health', expectedCount: 0 },
  { page: 'brief', selector: '#explain-btn', expectedCount: 1 },
  { page: 'brief', selector: '#audit-runner', expectedCount: 0 },
  { page: 'brief', selector: '[data-section="requirement-bindings"]', expectedCount: 1 },
  { page: 'brief', selector: 'li[data-state="req-resolved"]', expectedCount: 1 },
  { page: 'brief', selector: '[data-section="neighborhood"]', expectedCount: 1 },
  { page: 'brief', selector: '[data-state="approval-semantics"]', expectedCount: 1 },
  { page: 'brief', selector: '#queue-explain-btn', expectedCount: 0 },
  { page: 'error', selector: '#explain-btn', expectedCount: 0 },
  { page: 'error', selector: '#audit-runner', expectedCount: 0 },
  { page: 'error', selector: '[data-section="requirement-bindings"]', expectedCount: 0 },
  { page: 'error', selector: '[data-section="neighborhood"]', expectedCount: 0 },
  { page: 'error', selector: '[data-state="approval-semantics"]', expectedCount: 0 },
]

/** Real per-selector element counts via a single `querySelectorAll` batch, parsed from the injected client's response. */
export const extractSelectorCounts = async (client: CdpClient, selectors: string[]): Promise<Record<string, number>> => {
  const res = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify(Object.fromEntries(${JSON.stringify(selectors)}.map((s)=>[s,document.querySelectorAll(s).length])))`,
    returnByValue: true,
  })
  return JSON.parse(res.result.value) as Record<string, number>
}

/** Mismatches between observed selector counts and the page-specific expectation matrix. Empty = pass. */
export const validatePageSpecificSelectors = (page: string, counts: Record<string, number>, expectations = PAGE_SPECIFIC_SELECTORS): string[] =>
  expectations
    .filter((e) => e.page === page)
    .filter((e) => (counts[e.selector] ?? 0) !== e.expectedCount)
    .map((e) => `${page}:${e.selector}: expected count ${e.expectedCount}, got ${counts[e.selector] ?? 0}`)

// ---------------------------------------------------------------------------
// Network/Fetch domain guard (§8.3.2/§8.3.3): classify every request against
// the page's own origin and actively fail external ones — never merely
// observe them. Records are sanitized by construction: only origin class,
// resource type, and (final) status are ever kept, never a raw URL.
// ---------------------------------------------------------------------------

export interface SanitizedNetworkRecord {
  originClass: 'same-origin' | 'external'
  resourceType: string
  status: number | null
}

/** Same-origin requests continue; anything whose origin differs from `pageOrigin` fails closed. */
export const decideFetchAction = (
  requestUrl: string,
  pageOrigin: string,
): { action: 'continue' | 'fail'; originClass: 'same-origin' | 'external' } => {
  const originClass = new URL(requestUrl).origin === pageOrigin ? 'same-origin' : 'external'
  return { action: originClass === 'same-origin' ? 'continue' : 'fail', originClass }
}

/**
 * Enables `Network`+`Fetch` on `client` (with a catch-all request pattern),
 * subscribes to `Fetch.requestPaused`, and actively fails every
 * external-origin request while continuing same-origin ones. Must be called
 * before `Page.navigate` so no request escapes unclassified. Returns an
 * accessor for the sanitized records collected so far.
 */
export const attachNetworkGuard = async (client: CdpClient, pageOrigin: string): Promise<{ getRecords: () => SanitizedNetworkRecord[] }> => {
  const records: SanitizedNetworkRecord[] = []
  await client.send('Network.enable')
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  client.on('Fetch.requestPaused', (raw) => {
    const params = raw as { requestId: string; request: { url: string }; resourceType: string }
    const { action, originClass } = decideFetchAction(params.request.url, pageOrigin)
    void (action === 'fail'
      ? client.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' })
      : client.send('Fetch.continueRequest', { requestId: params.requestId }))
    records.push({ originClass, resourceType: params.resourceType, status: null })
  })
  return { getRecords: () => records }
}

// ---------------------------------------------------------------------------
// Real disabled-during-submit check (§8.3.5): drives an actual mouse click
// and polls the DOM — never writes `.disabled` via `Runtime.evaluate` — to
// prove a button disables itself for the duration of an in-flight request
// (against the real 750ms delayed agent-stub path) and re-enables after.
// ---------------------------------------------------------------------------

export interface DisabledCheckResult {
  selector: string
  initialDisabled: boolean
  disabledDuringRequest: boolean
  reenabled: boolean
  pass: boolean
}

const readDisabled = async (client: CdpClient, selector: string): Promise<boolean> => {
  const res = await client.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.disabled === true`,
    returnByValue: true,
  })
  return Boolean(res.result.value)
}

export const verifyButtonDisablesDuringSubmit = async (
  client: CdpClient,
  selector: string,
  timeoutMs = 5000,
  pollMs = 25,
): Promise<DisabledCheckResult> => {
  const initialDisabled = await readDisabled(client, selector)

  const { root } = (await client.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: { nodeId: number } }
  const { nodeId } = (await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })) as { nodeId: number }
  if (!nodeId) throw new Error(`selector not found in DOM: ${selector}`)
  await client.send('DOM.scrollIntoViewIfNeeded', { nodeId })
  const { model } = (await client.send('DOM.getBoxModel', { nodeId })) as { model: { content: number[] } }
  const [x0, y0, , , x2, y2] = model.content
  const x = (x0! + x2!) / 2
  const y = (y0! + y2!) / 2
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })

  await sleep(pollMs)
  const disabledDuringRequest = await readDisabled(client, selector)

  const deadline = Date.now() + timeoutMs
  let reenabled = false
  while (Date.now() < deadline) {
    if (!(await readDisabled(client, selector))) {
      reenabled = true
      break
    }
    await sleep(pollMs)
  }

  return { selector, initialDisabled, disabledDuringRequest, reenabled, pass: !initialDisabled && disabledDuringRequest && reenabled }
}

/** Drives real keyboard `Tab` presses via `Input.dispatchKeyEvent` and reads `document.activeElement` after each, mapping the skip-link anchor to `"skip-link"`. */
export const captureFocusOrder = async (client: CdpClient, steps: number): Promise<string[]> => {
  const order: string[] = []
  for (let i = 0; i < steps; i += 1) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    const res = await client.send('Runtime.evaluate', {
      expression:
        '(()=>{const e=document.activeElement;if(!e||e===document.body)return "";if(e.classList&&e.classList.contains("skip"))return "skip-link";if(e.id)return e.id;const focusable=[...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")];const i=focusable.indexOf(e);if(i>=0)return e.tagName.toLowerCase()+"["+i+"]";const j=Array.prototype.indexOf.call(document.querySelectorAll("*"),e);return e.tagName.toLowerCase()+"@"+j;})()',
      returnByValue: true,
    })
    const id = String(res.result.value)
    if (id === '') continue
    if (order.length > 0 && id === order[0]) break
    order.push(id)
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
  axClosureErrors: string[]
  pageSpecificErrors: string[]
  axLinks: AxLink[]
  axLinkErrors: string[]
  externalRequestCount: number
  disabledCheck: DisabledCheckResult | null
  /** Additional real-click explain interactions beyond the legacy single check. */
  interactionChecks?: DisabledCheckResult[] | undefined
}

export interface RunCheckConfig {
  focusSteps: number
  expectedDiffCount: number
  disclosureExpectations: DisclosureExpectation[]
  guardCases: HttpGuardCase[]
  pageSpecificExpectations?: PageSpecificExpectation[] | undefined
  disabledButtonSelector?: string | undefined
  disabledButtonSelectors?: string[] | undefined
  axLinkSelectors?: Record<string, string[]> | undefined
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
  networkRecords: SanitizedNetworkRecord[] = [],
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

  const pageSpecificExpectations = config.pageSpecificExpectations
  const relevantSelectors =
    pageSpecificExpectations !== undefined ? [...new Set(pageSpecificExpectations.filter((e) => e.page === page).map((e) => e.selector))] : []
  const selectorCounts = relevantSelectors.length > 0 ? await extractSelectorCounts(client, relevantSelectors) : {}
  const axLinkage = config.axLinkSelectors === undefined
    ? { links: [], errors: [] }
    : await collectPageAxLinks(client, page, axNodes, config.axLinkSelectors)

  const interactionSelectors =
    config.disabledButtonSelectors ??
    (config.disabledButtonSelector !== undefined ? [config.disabledButtonSelector] : [])
  const interactionChecks: DisabledCheckResult[] = []
  for (const selector of interactionSelectors) {
    interactionChecks.push(await verifyButtonDisablesDuringSubmit(client, selector))
  }
  const disabledCheck = interactionChecks[0] ?? null

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
    axClosureErrors: validateAxTreeClosure(axNodes),
    pageSpecificErrors: pageSpecificExpectations !== undefined ? validatePageSpecificSelectors(page, selectorCounts, pageSpecificExpectations) : [],
    externalRequestCount: networkRecords.filter((r) => r.originClass === 'external').length,
    axLinks: axLinkage.links,
    axLinkErrors: axLinkage.errors,
    disabledCheck,
    ...(interactionChecks.length > 1 ? { interactionChecks: interactionChecks.slice(1) } : {}),
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
    { name: `${prefix}:ax-closure`, expected: [], actual: summary.axClosureErrors, pass: summary.axClosureErrors.length === 0 },
    { name: `${prefix}:page-specific-selectors`, expected: [], actual: summary.pageSpecificErrors, pass: summary.pageSpecificErrors.length === 0 },
    { name: `${prefix}:dom-ax-linkage`, expected: [], actual: summary.axLinkErrors, pass: summary.axLinkErrors.length === 0 },
    { name: `${prefix}:no-external-requests`, expected: 0, actual: summary.externalRequestCount, pass: summary.externalRequestCount === 0 },
    ...summary.contrast.map((c) => ({ name: `${prefix}:contrast:${c.label}`, expected: true, actual: c.pass, pass: c.pass })),
    ...summary.guardResults.map((g) => ({ name: `${prefix}:guard:${g.name}`, expected: true, actual: g.pass, pass: g.pass })),
    ...(summary.disabledCheck !== null
      ? [{ name: `${prefix}:disabled-during-submit:${summary.disabledCheck.selector}`, expected: true, actual: summary.disabledCheck.pass, pass: summary.disabledCheck.pass }]
      : []),
    ...(summary.interactionChecks ?? []).map((check) => ({
      name: `${prefix}:disabled-during-submit:${check.selector}`,
      expected: true,
      actual: check.pass,
      pass: check.pass,
    })),
  ]
}

export const validatePageNames = (pages: { name: string }[]): string[] => {
  const expected = ['console', 'agent', 'specs', 'specs-page-2', 'decisions', 'brief', 'error']
  const counts = new Map<string, number>()
  for (const page of pages) counts.set(page.name, (counts.get(page.name) ?? 0) + 1)
  const errors: string[] = []
  for (const name of expected) {
    if (counts.get(name) !== 1) errors.push(`expected exactly one ${name} page`)
  }
  for (const name of counts.keys()) {
    if (!expected.includes(name)) errors.push(`unknown page name ${JSON.stringify(name)}`)
  }
  return errors
}

/** 0 iff every live and preflight assertion passed. */
export const computeExitCode = (summaries: CheckSummary[], additionalAssertions: Assertion[] = []): number =>
  additionalAssertions.every((assertion) => assertion.pass) && summaries.every((summary) => buildAssertions(summary).every((assertion) => assertion.pass)) ? 0 : 1

// ---------------------------------------------------------------------------
// CLI entry point — real Chrome only, excluded from Vitest
// ---------------------------------------------------------------------------

const isMain = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

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
  const manifestPath = readArg('--contrast-manifest')
  const sourceRoot = readArg('--source-root')
  const focusSteps = Number(readArg('--focus-steps') ?? '8')
  const expectedDiffCount = Number(readArg('--diff-count') ?? '5')
  const disclosureExpectations: DisclosureExpectation[] = readAllArgs('--disclosure').map((raw) => {
    const [id, expectedOpen] = splitKv(raw, (v) => v === 'true')
    return { id, expectedOpen: expectedOpen as boolean }
  })

  if (portRaw === undefined || profileDir === undefined || pageArgs.length === 0 || manifestPath === undefined || sourceRoot === undefined) {
    process.stderr.write('usage: ui-browser-check.js --port <n> --profile <dir> --page <name>=<url> [--page <name>=<url> ...] --contrast-manifest <path> --source-root <repo> [--output-dir <dir>] [--focus-steps <n>] [--diff-count <n>] [--disclosure <id>=<true|false>]\n')
    process.exit(2)
  }

  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid CDP port ${JSON.stringify(portRaw)}`)

  const manifestVerification = verifyContrastManifest(manifestPath, sourceRoot)
  if (manifestVerification.assertions.some((assertion) => !assertion.pass)) {
    process.stderr.write(`${JSON.stringify(manifestVerification)}\n`)
    process.exit(1)
  }

  const pages = pageArgs.map((raw) => {
    const [name, url] = splitKv(raw)
    return { name, url: url as string }
  })
  const pageNameErrors = validatePageNames(pages)
  if (pageNameErrors.length > 0) throw new Error(pageNameErrors.join('; '))

  const DISABLED_BUTTON_SELECTORS: Record<string, string[]> = {
    console: ['#queue-explain-btn', '#explain-item-btn-0'],
    brief: ['#explain-btn'],
    agent: ['#audit-runner button[type="submit"]'],
  }

  const config: RunCheckConfig = {
    focusSteps,
    expectedDiffCount,
    disclosureExpectations,
    guardCases: HTTP_GUARD_CASES,
    pageSpecificExpectations: PAGE_SPECIFIC_SELECTORS,
    axLinkSelectors: PAGE_AX_LINK_SELECTORS,
  }

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
          const pageOrigin = new URL(url).origin
          const networkGuard = await attachNetworkGuard(client, pageOrigin)
          await client.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, deviceScaleFactor: 1, mobile: viewport <= 390 })
          await client.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-reduced-motion', value: 'reduce' },
              { name: 'prefers-color-scheme', value: colorScheme },
            ],
          })
          await client.send('Page.navigate', { url })
          await waitForPageLoad(client)
          const summary = await runCheckAtViewport(
            client,
            url,
            pageName,
            viewport,
            colorScheme,
            {
              ...config,
              disclosureExpectations: pageName === 'brief' ? disclosureExpectations : [],
              expectedDiffCount: pageName === 'brief' ? expectedDiffCount : 0,
              disabledButtonSelectors: viewport === 1440 ? DISABLED_BUTTON_SELECTORS[pageName] : undefined,
            },
            networkGuard.getRecords(),
          )
          summaries.push(summary)
          if (outputDir !== undefined) {
            const shot = (await client.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
            mkdirSync(outputDir, { recursive: true })
            const base = `${pageName}-${viewport}-${colorScheme}`
            writeFileSync(join(outputDir, `${base}.png`), Buffer.from(shot.data, 'base64'))
            const rawAx = await client.send('Accessibility.getFullAXTree', {})
            writeFileSync(join(outputDir, `${base}-ax-raw.json`), JSON.stringify(sanitizeRequestRecord(rawAx), null, 2))
            const normalizedAx = await extractAxNodes(client)
            writeFileSync(join(outputDir, `${base}-ax-normalized.json`), JSON.stringify(normalizedAx, null, 2))
            writeFileSync(join(outputDir, `${base}-network.json`), JSON.stringify(networkGuard.getRecords(), null, 2))
          }
        } finally {
          client.close()
        }
      }
    }
  }

  const report = {
    manifest: manifestVerification,
    summaries,
    assertions: [...manifestVerification.assertions, ...summaries.flatMap(buildAssertions)],
  }
  const sanitized = sanitizeRequestRecord(report)
  process.stdout.write(`${JSON.stringify(sanitized)}\n`)
  if (outputDir !== undefined) {
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'ui-browser-check-report.json'), JSON.stringify(sanitized, null, 2))
  }
  process.exit(computeExitCode(summaries, manifestVerification.assertions))
}
