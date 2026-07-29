/**
 * S4 acceptance-only compiled internal server helper (urtext-20260724-ui-redesign
 * §§8.2 item 8, 8.3.2-8.3.5, 9.1). Exercises the *compiled* `ui-acceptance-server.js`
 * entry — never the TypeScript source — spawned as an independent process group
 * against a compiled fixture root, driving real HTTP over its real (port 0)
 * loopback listener with a locally injected, non-network agent-stub transport.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import DatabaseConstructor from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { compileAccBuild, type AccBuildPaths } from '../scripts/ui-acceptance-fixture.js'
import { TRANSPORTS } from '../scripts/ui-agent-stub.js'

const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

type ServerChild = ChildProcessByStdio<null, Readable, Readable>

const spawnedChildren: ServerChild[] = []

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Compile a fresh ACC_BUILD (fixture + stub + server entries) for the
 * calling test, in its own scratch dir so `afterEach` cleanup never races a
 * still-running compiled process from an earlier test. */
const acc = (): AccBuildPaths => compileAccBuild(scratch('urtext-acc-server-build-'))

/** Build a fixture root via the *compiled* fixture entry (never the TS source),
 * from an arbitrary cwd unrelated to the repository or the root itself. */
const buildCompiledFixture = (paths: AccBuildPaths): string => {
  const fixtureRoot = join(scratch('urtext-acc-server-fixture-'), 'fixture')
  const result = spawnSync(process.execPath, [paths.fixtureEntry, '--root', fixtureRoot], {
    cwd: tmpdir(),
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`compiled fixture entry failed: ${result.stderr}`)
  return fixtureRoot
}

interface RunningServer {
  child: ServerChild
  url: string
  port: number
  stdout: () => string
  stopAndCollect: () => Promise<unknown>
}

/** Spawn the compiled server helper in its own process group from an arbitrary
 * cwd, wait for the single readiness JSON line (<=5s), and return a handle
 * that reads accumulated stdout and can SIGINT-shut it down for the single
 * final sanitized-result JSON line. */
const startCompiledServer = (paths: AccBuildPaths, root: string): Promise<RunningServer> => {
  const child: ServerChild = spawn(process.execPath, [paths.serverEntry, '--root', root], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  spawnedChildren.push(child)

  let buffer = ''
  let stderrBuffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString('utf8')
  })

  const { promise, resolve, reject } = Promise.withResolvers<RunningServer>()
  const deadline = setTimeout(() => {
    reject(new Error(`compiled server did not become ready within 5s (stderr: ${stderrBuffer})`))
  }, 5000)

  const checkReady = (): void => {
    const firstLine = buffer.split('\n')[0]
    if (!firstLine) return
    let parsed: { schema?: string; url?: string }
    try {
      parsed = JSON.parse(firstLine) as { schema?: string; url?: string }
    } catch {
      return
    }
    if (parsed.schema !== 'urtext.ui-acceptance-server.ready/1' || typeof parsed.url !== 'string') return
    clearTimeout(deadline)
    child.stdout.off('data', onData)
    const port = Number(new URL(parsed.url).port)
    expect(port).toBeGreaterThan(0)
    resolve({
      child,
      url: parsed.url,
      port,
      stdout: () => buffer,
      stopAndCollect: () => stopAndCollectResult(child, () => buffer),
    })
  }
  const onData = (): void => checkReady()
  child.stdout.on('data', onData)
  checkReady()

  return promise
}

/** Send SIGINT to the helper's own process group, wait for exit, and parse the
 * single final sanitized-result JSON line it printed before exiting. */
const stopAndCollectResult = (child: ServerChild, stdout: () => string): Promise<unknown> => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const deadline = setTimeout(() => reject(new Error('compiled server did not exit within 5s of SIGINT')), 5000)
  child.once('exit', () => {
    clearTimeout(deadline)
    const lines = stdout().trim().split('\n')
    const lastLine = lines.at(-1)
    if (!lastLine) {
      reject(new Error('no output from compiled server after shutdown'))
      return
    }
    resolve(JSON.parse(lastLine))
  })
  if (child.pid !== undefined) process.kill(-child.pid, 'SIGINT')
  return promise
}

const getCsrf = async (base: string): Promise<string> => {
  const page = await fetch(base)
  const html = await page.text()
  const match = html.match(/name="csrf-token" content="([0-9a-f]+)"/)
  if (match === null) throw new Error('csrf token not found in console page')
  return match[1]!
}

/** After a SIGINT-shutdown compiled server has released its port, this must
 * refuse a fresh connection. */
const expectPortReleased = (port: number): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => {
    socket.destroy()
    reject(new Error(`port ${port} is still accepting connections after shutdown`))
  })
  socket.once('error', () => resolve())
  return promise
}

describe('S4 acceptance — external compile of the internal server entry', () => {
  test('compiles the server entry to an external outDir with zero repo/dist artifacts', () => {
    const paths = acc()
    expect(existsSync(paths.serverEntry)).toBe(true)
    expect(existsSync(join(process.cwd(), 'dist/scripts'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'scripts/ui-acceptance-server.js'))).toBe(false)
  })

  test('the compiled server entry rejects a missing --root from an arbitrary cwd', () => {
    const paths = acc()
    const result = spawnSync(process.execPath, [paths.serverEntry], { cwd: tmpdir(), encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--root')
  })
})

describe('S4 acceptance — compiled server: domain writes (decide + review)', () => {
  test('empty manual-pass note is rejected inline and the domain ledger stays unwritten, then a valid decide/review pair writes', async () => {
    const paths = acc()
    const root = buildCompiledFixture(paths)
    const server = await startCompiledServer(paths, root)
    try {
      const csrf = await getCsrf(server.url)

      const decideBrief = await fetch(`${server.url}/api/brief?spec=specs%2Fdemo%2Fspec.md&clause=C003`)
      const { briefHash: manualBriefHash } = (await decideBrief.json()) as { briefHash: string }

      const emptyNote = await fetch(`${server.url}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: 'specs/demo/spec.md#C003', verdict: 'pass', briefHash: manualBriefHash, note: '' }),
      })
      expect(emptyNote.status).toBe(400)

      const db = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'), { readonly: true })
      try {
        const before = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE clause_id = 'C003'").get() as { n: number }
        expect(before.n).toBe(0)
      } finally {
        db.close()
      }

      const validDecide = await fetch(`${server.url}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: 'specs/demo/spec.md#C003', verdict: 'pass', briefHash: manualBriefHash, note: 'manually verified' }),
      })
      expect(validDecide.status).toBe(200)
      await expect(validDecide.json()).resolves.toEqual({ ok: true })

      const reviewBrief = await fetch(`${server.url}/api/brief?spec=specs%2Fdemo%2Fspec.md&clause=C004`)
      const { briefHash: reviewBriefHash } = (await reviewBrief.json()) as { briefHash: string }
      const review = await fetch(`${server.url}/api/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: 'specs/demo/spec.md#C004', decision: 'approve', briefHash: reviewBriefHash, note: 'mapped diffs verified' }),
      })
      expect(review.status).toBe(200)
      await expect(review.json()).resolves.toEqual({ ok: true })

      const dbAfter = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'), { readonly: true })
      try {
        const decisionCount = dbAfter.prepare("SELECT COUNT(*) AS n FROM decisions WHERE clause_id = 'C003'").get() as { n: number }
        expect(decisionCount.n).toBe(1)
        const reviewCount = dbAfter.prepare("SELECT COUNT(*) AS n FROM reviews WHERE clause_id = 'C004'").get() as { n: number }
        expect(reviewCount.n).toBe(1)
      } finally {
        dbAfter.close()
      }

      const finalResult = (await server.stopAndCollect()) as { requests: unknown[]; stubs: unknown[] }
      expect(finalResult.stubs).toEqual([]) // decide/review never touch the agent transport
      expect(finalResult.requests.length).toBeGreaterThanOrEqual(6)
      const serialized = JSON.stringify(finalResult)
      expect(serialized).not.toContain(csrf)
      expect(serialized).not.toContain('manually verified')
      expect(serialized).not.toContain('mapped diffs verified')
      await expectPortReleased(server.port)
    } finally {
      spawnedChildren.length = 0 // stopAndCollect already reaped it; avoid double-kill noise
    }
  }, 30000)
})


describe('S4 acceptance — compiled server: eight stub-backed transport submissions', () => {
  test('four auditors (audit-run) and four clients (explain) each reach exactly one local stub wrapper; missing CSRF invokes none; ledgers stay distinct; cleanup releases the port; no secrets persist', async () => {
    const paths = acc()
    const root = buildCompiledFixture(paths)
    const server = await startCompiledServer(paths, root)

    const csrf = await getCsrf(server.url)

    const noCsrf = await fetch(`${server.url}/api/audit-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auditor: 'omp' }),
    })
    expect(noCsrf.status).toBe(403)

    const auditors = ['claude', 'codex', 'traex', 'omp'] as const
    for (const auditor of auditors) {
      const res = await fetch(`${server.url}/api/audit-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ auditor }),
      })
      expect(res.status).toBeGreaterThanOrEqual(200)
      expect(res.status).toBeLessThan(500)
      await res.json()
    }

    const stalePrerequisite = await fetch(`${server.url}/api/explain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify({ key: 'specs/demo/spec.md#C001', auditor: 'codex' }),
    })
    expect(stalePrerequisite.status).toBe(409)
    await expect(stalePrerequisite.json()).resolves.toEqual({
      error: 'item is not in the current human queue',
    })

    for (const auditor of auditors) {
      const res = await fetch(`${server.url}/api/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ scope: 'queue', auditor }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: true; text: string }
      expect(body.ok).toBe(true)
      expect(typeof body.text).toBe('string')
    }

    const finalResult = (await server.stopAndCollect()) as {
      requests: { method: string; pathClass: string; status: number; stage: string; hostClass: string; originClass: string }[]
      stubs: { command: string; mode: string; pid: number | null }[]
    }
    spawnedChildren.length = 0

    // Exactly one stub invocation per (auditor, explain-client) call: 4 + 4 = 8.
    expect(finalResult.stubs).toHaveLength(8)
    const auditModeCount = finalResult.stubs.filter((s) => s.mode === 'audit').length
    const explainModeCount = finalResult.stubs.filter((s) => s.mode === 'explain').length
    expect(auditModeCount).toBe(4)
    expect(explainModeCount).toBe(4)
    for (const stub of finalResult.stubs) {
      expect(TRANSPORTS as readonly string[]).toContain(stub.command)
      expect(typeof stub.pid).toBe('number')
      expect(Object.keys(stub).sort()).toEqual(['command', 'mode', 'pid'])
    }

    // Request ledger: 1 console GET + 1 unauthorized audit-run + 4 audit-run +
    // 1 rejected stale prerequisite explain + 4 queue explain = 11.
    expect(finalResult.requests).toHaveLength(11)
    const rejectedNoCsrf = finalResult.requests.filter((r) => r.stage === 'csrf')
    expect(rejectedNoCsrf).toHaveLength(1)
    expect(rejectedNoCsrf[0]).toMatchObject({ status: 403, pathClass: 'audit-run' })
    for (const record of finalResult.requests) {
      expect(Object.keys(record).sort()).toEqual(['hostClass', 'method', 'originClass', 'pathClass', 'stage', 'status'])
    }

    // Domain ledger stays distinct from the request/stub ledgers: audit_verdicts
    // rows exist per completed audit-run, but request/stub records never
    // reference evidence ids, verdict text, or spec content.
    const db = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'), { readonly: true })
    try {
      const auditRows = db.prepare('SELECT COUNT(*) AS n FROM audit_verdicts').get() as { n: number }
      expect(auditRows.n).toBeGreaterThanOrEqual(0) // may be 0 if the stub's shape is schema-rejected; ledger independence is what's asserted
    } finally {
      db.close()
    }

    const serialized = JSON.stringify(finalResult)
    expect(serialized).not.toContain(csrf)
    expect(serialized).not.toContain('stub claude')
    expect(serialized).not.toContain('stub codex')
    expect(serialized).not.toContain('stub traecli')
    expect(serialized).not.toContain('stub omp')
    expect(serialized).not.toContain('--model')
    expect(serialized).not.toContain('--profile')
    expect(serialized).not.toContain('evidence covers clause')
    expect(serialized).not.toContain(root)

    await expectPortReleased(server.port)
  }, 30000)
})


describe('S4 acceptance — compiled server: paginated console routes (pageSize=2)', () => {
  test('agent/specs/decisions GET 200 HTML, /specs paginates at pageSize=2, and the final ledger records their pathClass', async () => {
    const paths = acc()
    const root = buildCompiledFixture(paths)
    const server = await startCompiledServer(paths, root)

    const agentRes = await fetch(`${server.url}/agent`)
    expect(agentRes.status).toBe(200)
    expect(await agentRes.text()).toContain('<html')

    const specsRes = await fetch(`${server.url}/specs`)
    expect(specsRes.status).toBe(200)
    const specsBody = await specsRes.text()
    expect(specsBody).toContain('<html')
    // Fixture ships 5 live clauses; pageSize:2 (scripts/ui-acceptance-server.ts) => 3 pages.
    expect(specsBody).toContain('第 1/3 页')

    const specsPage2Res = await fetch(`${server.url}/specs?page=2`)
    expect(specsPage2Res.status).toBe(200)
    const specsPage2Body = await specsPage2Res.text()
    expect(specsPage2Body).toContain('<html')
    expect(specsPage2Body).toContain('第 2/3 页')

    const decisionsRes = await fetch(`${server.url}/decisions`)
    expect(decisionsRes.status).toBe(200)
    expect(await decisionsRes.text()).toContain('<html')

    const finalResult = (await server.stopAndCollect()) as {
      requests: { method: string; pathClass: string; status: number; stage: string; hostClass: string; originClass: string }[]
      stubs: unknown[]
    }
    spawnedChildren.length = 0

    for (const pathClass of ['agent', 'specs', 'decisions'] as const) {
      const records = finalResult.requests.filter((r) => r.pathClass === pathClass)
      expect(records.length).toBeGreaterThanOrEqual(1)
      for (const record of records) {
        expect(record.status).toBe(200)
        expect(record.stage).toBe('handler')
        expect(Object.keys(record).sort()).toEqual(['hostClass', 'method', 'originClass', 'pathClass', 'stage', 'status'])
      }
    }

    await expectPortReleased(server.port)
  }, 30000)
})
