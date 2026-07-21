/**
 * Ephemeral review server behind `urtext ui`. A foreground, interactive-session
 * process bound to loopback — started for a review, gone on Ctrl-C. It is not a
 * daemon (no fork, no pid file, no auto-start): the same category as the editor
 * `git rebase -i` spawns (VISION P8 reconciliation, see command-reference).
 *
 * Hardening (see tests/review-ui.test.ts for the pure logic): loopback-only,
 * per-session CSRF token, Origin/Host checks, JSON content-type required, body
 * cap, and a top-level try/catch so a malformed request returns 400/500 rather
 * than crashing the process.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { scanWorkspace } from './scanner.js'
import { buildUiSnapshot, renderPage, handleDecide, handleReview, handleBrief, handleAuditRun, renderBriefPage } from './review-ui.js'

export interface UiServerHandle {
  url: string
  close: () => void
}

const MAX_BODY = 4096

/** The bound TCP port, or null when the address is a pipe/not yet listening. */
const serverPort = (server: Server): number | null => {
  const addr = server.address()
  return addr !== null && typeof addr === 'object' ? addr.port : null
}

/** Accept only loopback Host and same-origin (or no Origin) POSTs. */
const isSameOrigin = (req: { headers: Record<string, string | string[] | undefined> }, port: number): boolean => {
  const host = String(req.headers.host ?? '')
  const okHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`
  const origin = req.headers.origin
  if (origin === undefined) return okHost
  return okHost && (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`)
}

export const startUiServer = (
  db: Database,
  root: string,
  opts: { port?: number; open?: boolean; decider: string }
): Promise<UiServerHandle> => {
  const csrfToken = randomBytes(16).toString('hex')

  const server: Server = createServer(async (req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    try {
      const port = serverPort(server)
      if (port === null) return json(500, { error: 'server not listening' })
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (req.method === 'POST' && url.pathname === '/api/decide') {
        if (!isSameOrigin(req, port)) return json(403, { error: 'forbidden origin' })
        if (req.headers['x-csrf'] !== csrfToken) return json(403, { error: 'bad csrf token' })
        if (!String(req.headers['content-type'] ?? '').includes('application/json'))
          return json(415, { error: 'expected application/json' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) return json(413, { error: 'request too large' })
        }
        let input: unknown
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return json(400, { error: 'malformed json' })
        }
        const result = handleDecide(db, root, input, opts.decider)
        return json(result.status, result.body)
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        if (!isSameOrigin(req, port)) return json(403, { error: 'forbidden origin' })
        if (req.headers['x-csrf'] !== csrfToken) return json(403, { error: 'bad csrf token' })
        if (!String(req.headers['content-type'] ?? '').includes('application/json'))
          return json(415, { error: 'expected application/json' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) return json(413, { error: 'request too large' })
        }
        let input: unknown
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return json(400, { error: 'malformed json' })
        }
        const result = handleReview(db, root, input, opts.decider)
        return json(result.status, result.body)
      }
      if (req.method === 'POST' && url.pathname === '/api/audit-run') {
        if (!isSameOrigin(req, port)) return json(403, { error: 'forbidden origin' })
        if (req.headers['x-csrf'] !== csrfToken) return json(403, { error: 'bad csrf token' })
        if (!String(req.headers['content-type'] ?? '').includes('application/json'))
          return json(415, { error: 'expected application/json' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY) return json(413, { error: 'request too large' })
        }
        let input: unknown
        try {
          input = JSON.parse(body || '{}')
        } catch {
          return json(400, { error: 'malformed json' })
        }
        const result = await handleAuditRun(db, input)
        return json(result.status, result.body)
      }
      if (req.method === 'GET' && url.pathname === '/api/brief') {
        scanWorkspace(db, root)
        const result = handleBrief(db, root, url.searchParams.get('spec'), url.searchParams.get('clause'))
        return json(result.status, result.body)
      }
      if (req.method === 'GET' && url.pathname === '/brief') {
        scanWorkspace(db, root)
        const result = handleBrief(db, root, url.searchParams.get('spec'), url.searchParams.get('clause'))
        if ('error' in result.body) return json(result.status, result.body)
        const key = `${url.searchParams.get('spec')}#${url.searchParams.get('clause')}`
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderBriefPage(result.body.text, csrfToken, key, result.body.briefHash, result.body.reviewable))
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        scanWorkspace(db, root)
        const audit = url.searchParams.get('audit')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderPage(buildUiSnapshot(db, root), csrfToken, audit ?? undefined))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) })
    }
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
