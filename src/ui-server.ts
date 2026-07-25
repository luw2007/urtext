/**
 * Ephemeral review server behind `urtext ui`. A foreground, interactive-session
 * process bound to loopback — started for a review, gone on Ctrl-C. It is not a
 * daemon (no fork, no pid file, no auto-start): the same category as the editor
 * `git rebase -i` spawns (VISION P8 reconciliation, see command-reference).
 *
 * Hardening (see tests/review-ui.test.ts for the pure logic; tests/ui-server.test.ts
 * for the HTTP matrix): loopback-only Host, same-origin POST, per-session CSRF
 * token, exact JSON media type, byte-accurate body cap, and a top-level
 * try/catch so a malformed request returns 400/500 rather than crashing the
 * process. Every request emits exactly one internal, redacted acceptance
 * record through `onRequest` — never raw pathname/query/header/body/prompt.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import type { AgentTransportDeps } from './audit-runner.js'
import { scanWorkspace } from './scanner.js'
import {
  buildUiSnapshot,
  handleAuditRun,
  handleBrief,
  handleDecide,
  handleExplain,
  handleReview,
} from './review-ui.js'
import { readUiRenderConfig, type UiRenderConfig } from './ui/contracts.js'
import { renderBriefErrorPage, renderBriefPage } from './ui/render-brief.js'
import { renderConsoleFamilyPage, type ConsoleRoute } from './ui/render-console.js'
import { readPageSize, resolvePage } from './ui/pagination.js'

export interface UiServerHandle {
  url: string
  close: () => void
}

const MAX_BODY_BYTES = 4096

type PathClass = 'console' | 'agent' | 'specs' | 'decisions' | 'brief' | 'brief-api' | 'decide' | 'review' | 'explain' | 'audit-run' | 'missing'
type Stage = 'host' | 'origin' | 'csrf' | 'media-type' | 'body-cap' | 'validation' | 'handler' | 'not-found'

const CONSOLE_ROUTE: Partial<Record<PathClass, ConsoleRoute>> = {
  console: 'queue',
  agent: 'agent',
  specs: 'specs',
  decisions: 'decisions',
}
type HostClass = 'loopback' | 'hostile'
type OriginClass = 'absent' | 'loopback' | 'hostile'

/** Internal, package-private acceptance record — one per request, redacted:
 * no raw pathname/query/header/CSRF/body/prompt/model/profile value. */
export interface AcceptanceRequestRecord {
  method: string
  pathClass: PathClass
  status: number
  stage: Stage
  hostClass: HostClass
  originClass: OriginClass
}

interface InternalOpts {
  port?: number
  open?: boolean
  decider: string
  agentDeps?: AgentTransportDeps
  onRequest?: (record: AcceptanceRequestRecord) => void
  pageSize?: number
}

/** The bound TCP port, or null when the address is a pipe/not yet listening. */
const serverPort = (server: Server): number | null => {
  const addr = server.address()
  return addr !== null && typeof addr === 'object' ? addr.port : null
}

const classifyHost = (headers: IncomingMessage['headers'], port: number): HostClass => {
  const host = String(headers.host ?? '')
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? 'loopback' : 'hostile'
}

const classifyOrigin = (headers: IncomingMessage['headers'], port: number): OriginClass => {
  const origin = headers.origin
  if (origin === undefined) return 'absent'
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` ? 'loopback' : 'hostile'
}

const pathClassOf = (method: string, pathname: string): PathClass => {
  if (method === 'GET' && pathname === '/') return 'console'
  if (method === 'GET' && pathname === '/agent') return 'agent'
  if (method === 'GET' && pathname === '/specs') return 'specs'
  if (method === 'GET' && pathname === '/decisions') return 'decisions'
  if (method === 'GET' && pathname === '/brief') return 'brief'
  if (method === 'GET' && pathname === '/api/brief') return 'brief-api'
  if (method === 'POST' && pathname === '/api/decide') return 'decide'
  if (method === 'POST' && pathname === '/api/review') return 'review'
  if (method === 'POST' && pathname === '/api/explain') return 'explain'
  if (method === 'POST' && pathname === '/api/audit-run') return 'audit-run'
  return 'missing'
}

/** RFC 7231 token / quoted-string grammar, restricted to what a `content-type`
 * parameter needs. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const QUOTED = /^"(?:[^"\\]|\\.)*"$/

/** Exact, case-insensitive `application/json` with well-formed `; name=value`
 * parameters only — no substring/prefix/suffix match (rejects `text/plain;
 * application/json`, `application/json-patch+json`, malformed params). The
 * header must appear exactly once (Node silently drops duplicate content-type
 * lines from `req.headers`, so duplicates are detected from `rawHeaders`). */
const isExactJsonContentType = (req: IncomingMessage): boolean => {
  let occurrences = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if ((req.rawHeaders[i] ?? '').toLowerCase() === 'content-type') occurrences++
  }
  if (occurrences !== 1) return false
  const raw = req.headers['content-type']
  if (typeof raw !== 'string') return false
  const parts = raw.split(';')
  if ((parts[0] ?? '').trim().toLowerCase() !== 'application/json') return false
  for (const param of parts.slice(1)) {
    const trimmed = param.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return false
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!TOKEN.test(name)) return false
    if (!TOKEN.test(value) && !QUOTED.test(value)) return false
  }
  return true
}

/** Reads the body up to `MAX_BODY_BYTES` counted in real HTTP bytes (never JS
 * string length): no `setEncoding`, each chunk sized via `Buffer.isBuffer(chunk)
 * ? chunk.byteLength : Buffer.byteLength(chunk)`. Exceeding the cap stops
 * immediately without concatenating, parsing, or dispatching. */
const readBodyWithCap = async (req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
    total += size
    if (total > MAX_BODY_BYTES) return { ok: false }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return { ok: true, text: Buffer.concat(chunks, total).toString('utf8') }
}

interface Ctx {
  db: Database
  root: string
  csrfToken: string
  decider: string
  agentDeps: AgentTransportDeps
  config: UiRenderConfig
  pageSize: number
}

const dispatchGet = async (
  ctx: Ctx,
  pathClass: PathClass,
  url: URL,
  res: ServerResponse
): Promise<{ status: number; stage: Stage }> => {
  const html = (code: number, body: string) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  const json = (code: number, obj: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  const route = CONSOLE_ROUTE[pathClass]
  if (route !== undefined) {
    scanWorkspace(ctx.db, ctx.root)
    const audit = route === 'agent' ? url.searchParams.get('audit') : null
    html(
      200,
      renderConsoleFamilyPage({
        route,
        snapshot: buildUiSnapshot(ctx.db, ctx.root),
        csrfToken: ctx.csrfToken,
        page: resolvePage(url.searchParams),
        pageSize: ctx.pageSize,
        ...(audit !== null ? { auditResult: audit } : {}),
      })
    )
    return { status: 200, stage: 'handler' }
  }
  if (pathClass === 'brief-api') {
    scanWorkspace(ctx.db, ctx.root)
    const result = handleBrief(ctx.db, ctx.root, url.searchParams.get('spec'), url.searchParams.get('clause'))
    json(result.status, result.body)
    return { status: result.status, stage: 'handler' }
  }
  if (pathClass === 'brief') {
    scanWorkspace(ctx.db, ctx.root)
    const result = handleBrief(ctx.db, ctx.root, url.searchParams.get('spec'), url.searchParams.get('clause'))
    if ('error' in result.body) {
      html(result.status, renderBriefErrorPage(result.body.error))
      return { status: result.status, stage: 'handler' }
    }
    const key = `${url.searchParams.get('spec')}#${url.searchParams.get('clause')}`
    html(
      200,
      renderBriefPage({
        text: result.body.text,
        csrfToken: ctx.csrfToken,
        key,
        briefHash: result.body.briefHash,
        reviewable: result.body.reviewable,
        facts: result.body.facts,
        view: result.body.view,
        config: ctx.config,
      })
    )
    return { status: 200, stage: 'handler' }
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
  return { status: 404, stage: 'not-found' }
}

const dispatchPost = async (
  ctx: Ctx,
  pathClass: PathClass,
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ status: number; stage: Stage }> => {
  const json = (code: number, obj: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (pathClass === 'missing') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return { status: 404, stage: 'not-found' }
  }
  if (req.headers['x-csrf'] !== ctx.csrfToken) {
    json(403, { error: 'bad csrf token' })
    return { status: 403, stage: 'csrf' }
  }
  if (!isExactJsonContentType(req)) {
    json(415, { error: 'expected application/json' })
    return { status: 415, stage: 'media-type' }
  }
  const body = await readBodyWithCap(req)
  if (!body.ok) {
    json(413, { error: 'request too large' })
    return { status: 413, stage: 'body-cap' }
  }
  let input: unknown
  try {
    input = JSON.parse(body.text || '{}')
  } catch {
    json(400, { error: 'malformed json' })
    return { status: 400, stage: 'validation' }
  }
  if (pathClass === 'decide') {
    const result = handleDecide(ctx.db, ctx.root, input, ctx.decider)
    json(result.status, result.body)
    return { status: result.status, stage: 'handler' }
  }
  if (pathClass === 'review') {
    const result = handleReview(ctx.db, ctx.root, input, ctx.decider)
    json(result.status, result.body)
    return { status: result.status, stage: 'handler' }
  }
  if (pathClass === 'explain') {
    scanWorkspace(ctx.db, ctx.root)
    const result = await handleExplain(ctx.db, ctx.root, input, ctx.agentDeps)
    json(result.status, result.body)
    return { status: result.status, stage: 'handler' }
  }
  // pathClass === 'audit-run'
  const result = await handleAuditRun(ctx.db, input, ctx.agentDeps)
  json(result.status, result.body)
  return { status: result.status, stage: 'handler' }
}

/** Internal server construction: accepts test/acceptance-only `agentDeps`
 * (injected `spawnAsync`) and `onRequest` (redacted request ledger). Never
 * exported from the public package barrel — deep-import only, from inside
 * this repository's source/build tree. */
export const startUiServerWithDeps = (db: Database, root: string, opts: InternalOpts): Promise<UiServerHandle> => {
  const csrfToken = randomBytes(16).toString('hex')
  const config = readUiRenderConfig(process.env)
  const pageSize = opts.pageSize ?? readPageSize(process.env)
  const ctx: Ctx = { db, root, csrfToken, decider: opts.decider, agentDeps: opts.agentDeps ?? {}, config, pageSize }

  const server: Server = createServer((req, res) => {
    void (async () => {
      let record: AcceptanceRequestRecord | undefined
      const emit = (status: number, stage: Stage, hostClass: HostClass, originClass: OriginClass, pathClass: PathClass) => {
        record = { method: req.method ?? 'GET', pathClass, status, stage, hostClass, originClass }
      }
      try {
        const port = serverPort(server)
        if (port === null) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'server not listening' }))
          return
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        const method = req.method ?? 'GET'
        const pathClass = pathClassOf(method, url.pathname)
        const hostClass = classifyHost(req.headers, port)
        if (hostClass === 'hostile') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'forbidden host' }))
          emit(403, 'host', hostClass, 'absent', pathClass)
          return
        }
        if (method === 'POST') {
          const originClass = classifyOrigin(req.headers, port)
          if (originClass === 'hostile') {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'forbidden origin' }))
            emit(403, 'origin', hostClass, originClass, pathClass)
            return
          }
          const outcome = await dispatchPost(ctx, pathClass, req, res)
          emit(outcome.status, outcome.stage, hostClass, originClass, pathClass)
          return
        }
        if (method === 'GET') {
          const outcome = await dispatchGet(ctx, pathClass, url, res)
          emit(outcome.status, outcome.stage, hostClass, 'absent', pathClass)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        emit(404, 'not-found', hostClass, 'absent', 'missing')
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      } finally {
        if (record !== undefined) opts.onRequest?.(record)
      }
    })()
  })

  const { promise, resolve } = Promise.withResolvers<UiServerHandle>()
  server.listen(opts.port ?? 0, '127.0.0.1', () => {
    const port = serverPort(server)
    if (port === null) throw new Error('server failed to bind a port')
    const url = `http://127.0.0.1:${port}`
    if (opts.open !== false) {
      // macOS `open`, Linux `xdg-open`; failure is non-fatal (print the url).
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {})
    }
    resolve({ url, close: () => server.close() })
  })
  return promise
}

/** Public entry point behind `urtext ui`. Signature and runtime surface are
 * frozen: it only delegates to the internal implementation and never accepts
 * or exposes `agentDeps`/`onRequest`. */
export const startUiServer = (
  db: Database,
  root: string,
  opts: { port?: number; open?: boolean; decider: string }
): Promise<UiServerHandle> => startUiServerWithDeps(db, root, opts)
