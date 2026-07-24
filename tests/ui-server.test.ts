import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { startUiServer, type UiServerHandle } from '../src/ui-server.js'

let db: Database
let root: string
let server: UiServerHandle

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

beforeEach(async () => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  root = mkdtempSync(join(tmpdir(), 'urtext-ui-server-'))
  git('init', '-q')
  git('config', 'user.email', 'test@urtext.dev')
  git('config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), [
    '## C001 guarded <!-- oracle:cmd:true risk:high -->',
    '## C002 dependent <!-- oracle:cmd:true refs:specs/x/spec.md#C001 -->',
  ].join('\n'))
  writeFileSync(join(root, 'tracked.txt'), 'baseline')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  server = await startUiServer(db, root, { port: 0, open: false, decider: 'test' })
})

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

  test('serves every live clause in the console spec browser', async () => {
    const response = await fetch(server.url)
    const html = await response.text()
    expect(html).toContain('id="all-specs"')
    expect(html).toContain('data-clause="specs/x/spec.md#C001"')
    expect(html).toContain('/brief?spec=specs%2Fx%2Fspec.md&amp;clause=C001')
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

    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 broken <!-- oracle:nope -->')
    const notReady = await fetch(`${server.url}/brief?spec=specs%2Fx%2Fspec.md&clause=C001`)
    expect(notReady.status).toBe(409)
    expect(notReady.headers.get('content-type')).toContain('text/html')
    expect(await notReady.text()).toContain('[not_ready]')
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
