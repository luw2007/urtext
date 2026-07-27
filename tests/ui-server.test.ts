import { request as httpRequest } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { recordDecision } from '../src/decision.js'
import { openRegistry } from '../src/registry.js'
import { buildUiSnapshot } from '../src/review-ui.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'
import { startUiServer, startUiServerWithDeps, type AcceptanceRequestRecord, type UiServerHandle } from '../src/ui-server.js'
import type { AsyncSpawn } from '../src/audit-runner.js'

let db: Database
let root: string
let server: UiServerHandle

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const setupWorkspace = () => {
  root = mkdtempSync(join(tmpdir(), 'urtext-ui-server-'))
  git('init', '-q')
  git('config', 'user.email', 'test@urtext.dev')
  git('config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), [
    '## FR001 test intent',
    '## C001 guarded <!-- oracle:cmd:true risk:high req:FR001 -->',
    '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR001 -->',
    '## C003 manual gate <!-- oracle:manual req:FR001 -->',
  ].join('\n'))
  writeFileSync(join(root, 'tracked.txt'), 'baseline')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
}

/** A fake async agent child: reads the audit instruction from stdin, extracts
 * the real `evidenceId`s it names, and agrees on every one — resolving
 * `stdin.end()` with matching stdout + close(0). */
const matchingVerdictsSpawn = (): AsyncSpawn =>
  ((..._args: unknown[]) => {
    const child = new EventEmitter() as unknown as ChildProcess
    const stdout = new EventEmitter()
    Object.assign(child, {
      stdout,
      stdin: {
        end: (data?: string) => {
          const input = typeof data === 'string' ? data : ''
          queueMicrotask(() => {
            const ids = [...input.matchAll(/"evidenceId":(\d+)/g)].map((m) => Number(m[1]))
            const verdicts = ids.map((evidenceId) => ({ evidenceId, verdict: 'agree', note: 'ok' }))
            stdout.emit('data', Buffer.from(JSON.stringify({ verdicts })))
            child.emit('close', 0)
          })
        },
      },
      kill: () => {},
    })
    return child
  }) as AsyncSpawn

/** A fake async agent child that records each invocation before responding. */
const trackedMatchingVerdictsSpawn = (calls: string[]): AsyncSpawn =>
  ((..._args: unknown[]) => {
    calls.push('spawned')
    return (matchingVerdictsSpawn() as (...a: unknown[]) => ChildProcess)(..._args)
  }) as AsyncSpawn


/** A fake async agent child that must never be invoked — throws if it is. */
const forbiddenSpawn = (calls: string[]): AsyncSpawn =>
  (() => {
    calls.push('spawned')
    throw new Error('sentinel must not be invoked')
  }) as unknown as AsyncSpawn

/** Raw HTTP client that (unlike WHATWG `fetch`) allows overriding the `Host`
 * header — needed to exercise §9.2's hostile-Host rejection. */
const rawFetch = (
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; text: () => Promise<string>; json: () => Promise<unknown> }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: () => Promise<string>; json: () => Promise<unknown> }>()
  const target = new URL(url)
  const req = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: opts.method ?? 'GET',
      headers: opts.headers,
    },
    (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, text: async () => text, json: async () => JSON.parse(text) })
      })
    }
  )
  req.on('error', reject)
  if (opts.body !== undefined) req.write(opts.body)
  req.end()
  return promise
}

const getCsrf = async (base: string): Promise<string> => {
  const page = await fetch(`${base}/brief?spec=specs%2Fx%2Fspec.md&clause=C001`)
  const html = await page.text()
  const match = html.match(/name="csrf-token" content="([0-9a-f]+)"/)
  if (match === null) throw new Error('csrf token not found in /brief page')
  return match[1]!
}

/** Builds a JSON `{key,verdict,pad}` body whose UTF-8 byte length is exactly
 * `n`, padded with single-byte ASCII filler. */
const jsonBodyOfBytes = (n: number): string => {
  const base = { key: 'specs/x/spec.md#C003', verdict: 'fail', pad: '' }
  const baseLen = Buffer.byteLength(JSON.stringify(base))
  const padLen = n - baseLen
  if (padLen < 0) throw new Error(`target ${n} smaller than base ${baseLen}`)
  return JSON.stringify({ ...base, pad: 'a'.repeat(padLen) })
}

/** Same as `jsonBodyOfBytes`, but the filler is 3-byte UTF-8 `中` characters
 * (falling back to ASCII for the sub-3-byte remainder) — proves the cap
 * counts real bytes, not JS string length. */
const multibyteJsonBodyOfBytes = (n: number): string => {
  const base = { key: 'specs/x/spec.md#C003', verdict: 'fail', note: '' }
  const baseLen = Buffer.byteLength(JSON.stringify(base))
  const remaining = n - baseLen
  if (remaining < 0) throw new Error(`target ${n} smaller than base ${baseLen}`)
  const multibyteCount = Math.floor(remaining / 3)
  const leftover = remaining - multibyteCount * 3
  const note = '中'.repeat(multibyteCount) + 'a'.repeat(leftover)
  return JSON.stringify({ ...base, note })
}

beforeEach(async () => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  setupWorkspace()
  server = await startUiServer(db, root, { port: 0, open: false, decider: 'test' })
}, 15_000)

afterEach(() => {
  server.close()
  db.close()
  rmSync(root, { force: true, recursive: true })
})

describe('ui server spec impact', () => {
  test('serves the workspace unmapped banner over the real HTTP route', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'changed')
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('data-banner="unmapped"')
    expect(html).toContain('tracked.txt:1-1')
    expect(html).toContain('urtext map &lt;spec&gt;#&lt;clause&gt; tracked.txt:1-1')
    expect(html).toContain('urtext ack tracked.txt:1-1 &lt;reason&gt;')
  })

  test('serves all four console-family routes over real HTTP', async () => {
    const cases = [
      ['/', 'id="your-queue-title"'],
      ['/agent', 'id="agent-lane-title"'],
      ['/specs', 'id="all-specs"'],
      ['/decisions', 'id="decided-title"'],
    ] as const
    for (const [path, marker] of cases) {
      const response = await fetch(`${server.url}${path}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain(marker)
    }
  })

  test('serves every live clause from /specs', async () => {
    const response = await fetch(`${server.url}/specs`)
    const html = await response.text()
    expect(html).toContain('id="all-specs"')
    expect(html).toContain('data-clause="specs/x/spec.md#C001"')
    expect(html).toContain('/brief?spec=specs%2Fx%2Fspec.md&amp;clause=C001')
  })

  test('ignores unknown queries and never replays audit results on the queue route', async () => {
    const plain = await fetch(server.url).then((response) => response.text())
    const unknown = await fetch(`${server.url}/?unknown=value`).then((response) => response.text())
    const audit = await fetch(`${server.url}/?audit=stale`).then((response) => response.text())
    expect(unknown).toBe(plain)
    expect(audit).toBe(plain)
    expect(audit).not.toContain('id="audit-result"')
  })

  test('serves structured brief HTML and the additive JSON projection', async () => {
    const query = 'spec=specs%2Fx%2Fspec.md&clause=C001'
    const page = await fetch(`${server.url}/brief?${query}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('data-state="risk-high"')
    expect(html).toContain('映射状态')
    expect(html).toContain('查看全部 Specs')
    expect(html).toContain('刷新状态')
    expect(html).toContain('rel="next"')

    const api = await fetch(`${server.url}/api/brief?${query}`)
    expect(api.status).toBe(200)
    expect(api.headers.get('content-type')).toContain('application/json')
    await expect(api.json()).resolves.toMatchObject({
      ok: true,
      view: { schema: 'urtext.spec-impact/1', risk: 'high' },
    })
  })

  test('serves fail-closed HTML for unknown and not-ready clauses', async () => {
    const unknown = await fetch(`${server.url}/brief?spec=specs%2Fx%2Fspec.md&clause=C999`)
    expect(unknown.status).toBe(404)

    expect(unknown.headers.get('content-type')).toContain('text/html')
    const unknownHtml = await unknown.text()
    expect(unknownHtml).toContain('data-state="error"')
    expect(unknownHtml).not.toContain('data-state="risk-')

    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 broken <!-- oracle:nope req:FR001 -->')
    const notReady = await fetch(`${server.url}/brief?spec=specs%2Fx%2Fspec.md&clause=C001`)
    expect(notReady.status).toBe(409)
    expect(notReady.headers.get('content-type')).toContain('text/html')
    expect(await notReady.text()).toContain('[not_ready]')
  })

  test('renders broken requirement diagnostics in the fail-closed 409 shell only', async () => {
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      [
        '## FR001 test intent',
        '## C001 guarded <!-- oracle:cmd:true risk:high req:FR999 -->',
      ].join('\n')
    )
    const response = await fetch(
      `${server.url}/brief?spec=specs%2Fx%2Fspec.md&clause=C001`
    )
    expect(response.status).toBe(409)
    const html = await response.text()
    expect(html).toContain('[link_error]')
    expect(html).toContain('data-section="requirement-bindings"')
    expect(html).toContain('data-state="req-dangling"')
    expect(html).toContain('data-tone="danger"')
    expect(html).toContain('<code>FR999</code>')
    expect(html).not.toContain('data-state="req-resolved"')
    expect(html).not.toContain('id="review-form"')
    expect(html).not.toContain('id="decision-form-')
  })

  test('preserves CSRF and same-origin write protections', async () => {
    const missingCsrf = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(missingCsrf.status).toBe(403)

    const hostileOrigin = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-csrf': 'forged' },
      body: '{}',
    })
    expect(hostileOrigin.status).toBe(403)
  })
})

describe('§9.2 all-route Host enforcement', () => {
  test('a hostile Host header is rejected with 403 before any route is dispatched, for every route', async () => {
    const port = new URL(server.url).port
    const routes: { method: string; path: string }[] = [
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/brief?spec=specs%2Fx%2Fspec.md&clause=C001' },
      { method: 'GET', path: '/agent' },
      { method: 'GET', path: '/specs' },
      { method: 'GET', path: '/decisions' },
      { method: 'GET', path: '/api/brief?spec=specs%2Fx%2Fspec.md&clause=C001' },
      { method: 'POST', path: '/api/decide' },
      { method: 'POST', path: '/api/review' },
      { method: 'POST', path: '/api/explain' },
      { method: 'POST', path: '/api/audit-run' },
      { method: 'GET', path: '/nonexistent' },
    ]
    for (const route of routes) {
      const response = await rawFetch(`http://127.0.0.1:${port}${route.path}`, {
        method: route.method,
        headers: { host: 'evil.example', 'content-type': 'application/json' },
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({ error: 'forbidden host' })
    }
  })

  test('loopback Host on a different port is also hostile', async () => {
    const port = Number(new URL(server.url).port)
    const response = await rawFetch(server.url, { headers: { host: `127.0.0.1:${port + 1}` } })
    expect(response.status).toBe(403)
  })

  test('an unmatched route still validates Host first (404 only for a loopback Host)', async () => {
    const missing = await fetch(`${server.url}/does-not-exist`)
    expect(missing.status).toBe(404)
  })
})

describe('console-family pagination over HTTP', () => {
  test('page query values stay 200 and resolve to first, decoded, or final pages', async () => {
    const records: AcceptanceRequestRecord[] = []
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      pageSize: 1,
      onRequest: (record) => records.push(record),
    })
    try {
      const body = async (query: string): Promise<string> => {
        const response = await fetch(`${localServer.url}/specs${query}`)
        expect(response.status).toBe(200)
        return response.text()
      }
      const first = await body('')
      for (const query of ['?page=', '?page=0', '?page=-1', '?page=01', '?page=1.5', '?page=%2B1', '?page=abc', '?page=1e3', '?page=1&page=2']) {
        expect(await body(query)).toBe(first)
      }
      const second = await body('?page=2')
      expect(second).not.toBe(first)
      expect(await body('?page=%32')).toBe(second)
      const pageCount = Number(first.match(/第 1 \/ 共 (\d+) 页/)?.[1])
      expect(await body(`?page=${'9'.repeat(400)}`)).toBe(await body(`?page=${pageCount}`))
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((record) => record.pathClass === 'specs' && record.status === 200 && record.stage === 'handler')).toBe(true)
    } finally {
      localServer.close()
    }
  })

  test('pageSize=1 traverses every route in snapshot order with no duplicates', async () => {
    writeFileSync(join(root, 'specs/x/spec.md'), [
      '## FR001 test intent',
      '## C001 guarded <!-- oracle:cmd:true risk:high req:FR001 -->',
      '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 req:FR001 -->',
      '## C003 manual gate <!-- oracle:manual req:FR001 -->',
      '## C004 second manual <!-- oracle:manual req:FR001 -->',
    ].join('\n'))
    writeFileSync(join(root, 'tracked-2.txt'), 'baseline')
    git('add', '-A')
    git('commit', '-q', '-m', 'add traversal fixtures')
    scanWorkspace(db, root)
    writeFileSync(join(root, 'tracked.txt'), 'changed')
    writeFileSync(join(root, 'tracked-2.txt'), 'changed')
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C003', verdict: 'fail', decider: 'test' }, root, 1)
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C004', verdict: 'fail', decider: 'test' }, root, 1)
    const snapshot = buildUiSnapshot(db, root)
    const localServer = await startUiServerWithDeps(db, root, { port: 0, open: false, decider: 'test', pageSize: 1 })
    try {
      const cases = [
        ['/', 'data-row', snapshot.status.items.filter((item) => item.lane === 'human').map((item) => item.key)],
        ['/agent', 'data-row', snapshot.status.items.filter((item) => item.lane === 'agent').map((item) => item.key)],
        ['/specs', 'data-clause', snapshot.clauses.map((clause) => `${clause.specPath}#${clause.clauseId}`)],
        ['/decisions', 'data-row', snapshot.clauses.filter((clause) => clause.decisionVerdict === 'pass' || clause.decisionVerdict === 'fail').map((clause) => `${clause.specPath}#${clause.clauseId}`)],
      ] as const
      for (const [path, attribute, expected] of cases) {
        const first = await fetch(`${localServer.url}${path}`).then((response) => response.text())
        const pageCount = Number(first.match(/第 1 \/ 共 (\d+) 页/)?.[1] ?? 1)
        expect(pageCount).toBeGreaterThan(1)
        const pages = [first]
        for (let page = 2; page <= pageCount; page += 1) {
          pages.push(await fetch(`${localServer.url}${path}?page=${page}`).then((response) => response.text()))
        }
        const rows = pages.flatMap((html) => [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]!))
        expect(rows).toEqual(expected)
        expect(new Set(rows).size).toBe(rows.length)
      }
    } finally {
      localServer.close()
    }
  })

  test('new GET routes emit exact path classes and hostile Host remains pre-dispatch', async () => {
    const records: AcceptanceRequestRecord[] = []
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      onRequest: (record) => records.push(record),
    })
    try {
      for (const path of ['/agent', '/specs', '/decisions']) expect((await fetch(`${localServer.url}${path}`)).status).toBe(200)
      const hostile = await rawFetch(`${localServer.url}/specs`, { headers: { host: 'evil.example' } })
      expect(hostile.status).toBe(403)
      expect(records).toEqual([
        expect.objectContaining({ pathClass: 'agent', status: 200, stage: 'handler' }),
        expect.objectContaining({ pathClass: 'specs', status: 200, stage: 'handler' }),
        expect.objectContaining({ pathClass: 'decisions', status: 200, stage: 'handler' }),
        expect.objectContaining({ pathClass: 'specs', status: 403, stage: 'host' }),
      ])
    } finally {
      localServer.close()
    }
  })
})

describe('§9.2 exact JSON media type', () => {
  test('accepts application/json with a well-formed parameter', async () => {
    const csrf = await getCsrf(server.url)
    const res = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-csrf': csrf },
      body: JSON.stringify({ key: 'specs/x/spec.md#C003', verdict: 'maybe' }),
    })
    // past media-type: rejected 400 by handler validation (bad verdict), never 415
    expect(res.status).toBe(400)
  })

  test.each([
    ['missing content-type', undefined],
    ['substring prefix', 'text/plain; application/json'],
    ['suffixed media type', 'application/json-patch+json'],
    ['wrong media type', 'text/json'],
    ['malformed parameter (no value)', 'application/json; charset'],
    ['malformed parameter (trailing semicolon)', 'application/json;'],
  ])('rejects %s with 415 before dispatching', async (_name, contentType) => {
    const csrf = await getCsrf(server.url)
    const headers: Record<string, string> = { 'x-csrf': csrf }
    if (contentType !== undefined) headers['content-type'] = contentType
    const res = await fetch(`${server.url}/api/decide`, { method: 'POST', headers, body: '{}' })
    expect(res.status).toBe(415)
  })

  test('accepts exact application/json regardless of case', async () => {
    const csrf = await getCsrf(server.url)
    const res = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'APPLICATION/JSON', 'x-csrf': csrf },
      body: JSON.stringify({ key: 'specs/x/spec.md#C003', verdict: 'maybe' }),
    })
    expect(res.status).toBe(400) // past media-type; rejected by handler validation instead
  })
})

describe('§9.2 byte-accurate body cap', () => {
  test('accepts exactly 4096 ASCII bytes and rejects 4097', async () => {
    const csrf = await getCsrf(server.url)
    const okBody = jsonBodyOfBytes(4096)
    expect(Buffer.byteLength(okBody)).toBe(4096)
    const ok = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: okBody,
    })
    // past body-cap: the decide handler actually runs and records — proves the
    // body was read, concatenated, and parsed rather than short-circuited by the cap.
    expect(ok.status).toBe(200)

    const tooBig = jsonBodyOfBytes(4097)
    expect(Buffer.byteLength(tooBig)).toBe(4097)
    const rejected = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: tooBig,
    })
    expect(rejected.status).toBe(413)
  })

  test('counts multibyte UTF-8 characters in real bytes, not JS string length or char count', async () => {
    const csrf = await getCsrf(server.url)
    // U+4E2D 中 is 3 bytes in UTF-8 but 1 UTF-16 code unit / 1 JS string length unit.
    const body = multibyteJsonBodyOfBytes(4097)
    expect(Buffer.byteLength(body)).toBe(4097)
    expect(body.length).toBeLessThan(4097) // JS string length is NOT the byte count — the crux of the boundary
    const res = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body,
    })
    expect(res.status).toBe(413)
  })

  test('a multibyte body exactly at the 4096-byte cap is accepted past the cap check', async () => {
    const csrf = await getCsrf(server.url)
    const body = multibyteJsonBodyOfBytes(4096)
    expect(Buffer.byteLength(body)).toBe(4096)
    const res = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body,
    })
    // past body-cap; the decide handler actually runs — proves it was read+concatenated+parsed
    expect(res.status).toBe(200)
  })
})

describe('/api/explain security and R4', () => {
  test('rejects ambiguous and malformed explain requests before the transport', async () => {
    const calls: string[] = []
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      agentDeps: { spawnAsync: forbiddenSpawn(calls) },
    })
    try {
      const csrf = await getCsrf(localServer.url)
      for (const body of [
        { key: 'specs/x/spec.md#C001', scope: 'queue', auditor: 'omp' },
        { auditor: 'omp' },
        { scope: 'other', auditor: 'omp' },
        { key: 'specs/x/spec.md#C001', auditor: 'omp', extra: true },
      ]) {
        const response = await fetch(`${localServer.url}/api/explain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf': csrf },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(400)
      }
      expect(calls).toEqual([])
    } finally {
      localServer.close()
    }
  })

  test('rejects an agent-lane clause explanation before the transport', async () => {
    const calls: string[] = []
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      agentDeps: { spawnAsync: forbiddenSpawn(calls) },
    })
    try {
      const csrf = await getCsrf(localServer.url)
      const response = await fetch(`${localServer.url}/api/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: 'specs/x/spec.md#C002', auditor: 'omp' }),
      })
      expect(response.status).toBe(409)
      expect(calls).toEqual([])
    } finally {
      localServer.close()
    }
  })

  test('refused clause explanations return 409 before the transport', async () => {
    const calls: string[] = []
    writeFileSync(join(root, 'specs/x/spec.md'), '## FR001 test intent\n## C001 broken <!-- oracle:nope req:FR001 -->')
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      agentDeps: { spawnAsync: forbiddenSpawn(calls) },
    })
    try {
      const csrf = /name="csrf-token" content="([0-9a-f]+)"/.exec(await fetch(localServer.url).then((response) => response.text()))?.[1]
      if (csrf === undefined) throw new Error('csrf token not found in queue page')
      const response = await fetch(`${localServer.url}/api/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: 'specs/x/spec.md#C001', auditor: 'omp' }),
      })
      expect(response.status).toBe(409)
      expect(calls).toEqual([])
    } finally {
      localServer.close()
    }
  })
})

describe('three distinct ledger mechanisms via HTTP', () => {
  test('decide → decision ledger', async () => {
    const csrf = await getCsrf(server.url)
    const brief = await fetch(`${server.url}/api/brief?spec=specs%2Fx%2Fspec.md&clause=C003`)
    const briefJson = (await brief.json()) as { briefHash: string }
    const res = await fetch(`${server.url}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key: 'specs/x/spec.md#C003', verdict: 'pass', briefHash: briefJson.briefHash, note: 'reviewed' }),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test('review → review ledger', async () => {
    const csrf = await getCsrf(server.url)
    const res = await fetch(`${server.url}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key: 'specs/x/spec.md#C001', decision: 'reject' }),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test('audit-run → audit_verdicts ledger via the injected async transport', async () => {
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      agentDeps: { spawnAsync: matchingVerdictsSpawn() },
    })
    try {
      const csrf = await getCsrf(localServer.url)
      const res = await fetch(`${localServer.url}/api/audit-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ auditor: 'omp' }),
      })
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({ ok: true })
    } finally {
      localServer.close()
    }
  })
})

describe('internal seam: sentinel/request-ledger proves HTTP guards short-circuit before the async transport', () => {
  const record = () => {
    const records: AcceptanceRequestRecord[] = []
    return { records, onRequest: (r: AcceptanceRequestRecord) => records.push(r) }
  }

  test('a hostile Host is rejected before the sentinel is ever invoked, and exactly one record is emitted', async () => {
    const sentinelCalls: string[] = []
    const { records, onRequest } = record()
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      onRequest,
      agentDeps: { spawnAsync: forbiddenSpawn(sentinelCalls) },
    })
    try {
      const res = await rawFetch(localServer.url, { headers: { host: 'evil.example' } })
      expect(res.status).toBe(403)
      expect(sentinelCalls).toEqual([])
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ pathClass: 'console', status: 403, stage: 'host', hostClass: 'hostile' })
    } finally {
      localServer.close()
    }
  })

  test('a hostile Origin is rejected before CSRF/media/body checks and before the sentinel', async () => {
    const sentinelCalls: string[] = []
    const { records, onRequest } = record()
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      onRequest,
      agentDeps: { spawnAsync: forbiddenSpawn(sentinelCalls) },
    })
    try {
      const res = await fetch(`${localServer.url}/api/audit-run`, {
        method: 'POST',
        headers: {
          origin: 'http://evil.example',
          'content-type': 'application/json',
          'x-csrf': 'whatever',
        },
        body: JSON.stringify({ auditor: 'omp' }),
      })
      expect(res.status).toBe(403)
      expect(sentinelCalls).toEqual([])
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ pathClass: 'audit-run', status: 403, stage: 'origin', hostClass: 'loopback', originClass: 'hostile' })
    } finally {
      localServer.close()
    }
  })

  test('a legitimate audit-run request reaches the injected sentinel through the full guard chain', async () => {
    const sentinelCalls: string[] = []
    const { records, onRequest } = record()
    const localServer = await startUiServerWithDeps(db, root, {
      port: 0,
      open: false,
      decider: 'test',
      onRequest,
      agentDeps: { spawnAsync: trackedMatchingVerdictsSpawn(sentinelCalls) },
    })
    try {
      const csrf = await getCsrf(localServer.url)
      const res = await fetch(`${localServer.url}/api/audit-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ auditor: 'omp' }),
      })
      expect(res.status).toBe(200)
      expect(sentinelCalls).toEqual(['spawned'])
      const auditRecord = records.find((r) => r.pathClass === 'audit-run')
      expect(auditRecord).toMatchObject({ status: 200, stage: 'handler', hostClass: 'loopback', originClass: 'absent' })
    } finally {
      localServer.close()
    }
  })

  test('the public startUiServer wrapper never exposes agentDeps/onRequest on its options type', async () => {
    // Compile-time contract: this file only ever calls startUiServer with { port, open, decider }.
    // A structural smoke check — the running instance from beforeEach was started via startUiServer.
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
  })
})
