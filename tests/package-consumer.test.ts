import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  REPO_ROOT,
  bindNativeClosure,
  buildDist,
  cleanup,
  installOffline,
  listTarballEntries,
  makeScratchDir,
  packTarball,
} from '../scripts/package-consumer-fixture.js'

/**
 * I2 real deterministic-tarball-consumer proof: build → `npm pack` → offline
 * `--ignore-scripts` install into a throwaway project → bind the workspace's
 * already-built `better-sqlite3` native addon → exercise the *installed*
 * package's real runtime (three renderers, a real `startUiServer` lifecycle,
 * a rejected deep subpath import). No network call, no `postinstall`/prebuild
 * script execution, no dynamic install fallback anywhere in the chain.
 */

const scratchDirs: string[] = []
let consumerDir: string
let tarballPath: string

beforeAll(() => {
  buildDist()
  const packDir = makeScratchDir('urtext-pack-')
  scratchDirs.push(packDir)
  tarballPath = packTarball(packDir)

  consumerDir = makeScratchDir('urtext-consumer-')
  scratchDirs.push(consumerDir)
  installOffline(consumerDir, tarballPath)
}, 120_000)

afterAll(() => {
  cleanup(scratchDirs)
})

test('tarball ships only the intended files (dist/, README.md, LICENSE, package.json)', () => {
  const entries = listTarballEntries(tarballPath)
  const topLevel = new Set(entries.map((e) => e.split('/')[1] ?? e.split('/')[0]))
  for (const forbidden of ['tests', 'src', 'scripts', 'specs', 'docs', '.claude']) {
    expect([...topLevel]).not.toContain(forbidden)
  }
  expect(entries.some((e) => e.includes('dist/index.js'))).toBe(true)
  expect(entries.some((e) => e.includes('dist/index.d.ts'))).toBe(true)
  expect(entries.some((e) => e.includes('dist/cli.js'))).toBe(true)
})

describe('installed better-sqlite3 native closure', () => {
  test('offline --ignore-scripts install leaves no prebuilt native addon', () => {
    const binaryPath = join(consumerDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
    expect(existsSync(binaryPath)).toBe(false)
  })

  test('binding the workspace addon is a deterministic, hash-identical, version-matched copy', () => {
    const proof = bindNativeClosure(consumerDir)
    expect(proof.versionMatches).toBe(true)
    expect(proof.hashMatches).toBe(true)
    expect(proof.sourceHash).toBe(proof.installedHash)
    expect(proof.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ABI/platform proof: requiring better-sqlite3 in the consumer and opening a real in-memory database succeeds', () => {
    const script = `
      import Database from 'better-sqlite3'
      const db = new Database(':memory:')
      db.exec('CREATE TABLE t (id INTEGER)')
      db.prepare('INSERT INTO t VALUES (1)').run()
      const row = db.prepare('SELECT id FROM t').get()
      console.log(JSON.stringify({ ok: true, row, modules: process.versions.modules, platform: process.platform }))
      db.close()
    `
    writeFileSync(join(consumerDir, 'abi-check.mjs'), script)
    const result = spawnSync('node', ['abi-check.mjs'], { cwd: consumerDir, encoding: 'utf8' })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout.trim())
    expect(parsed.ok).toBe(true)
    expect(parsed.row).toEqual({ id: 1 })
    expect(parsed.modules).toBe(process.versions.modules)
    expect(parsed.platform).toBe(process.platform)
  })
})

describe('installed runtime consumer — package `.` export only', () => {
  test('three renderers, real startUiServer lifecycle, and a rejected deep import', () => {
    const script = `
      import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { spawnSync } from 'node:child_process'
      import { request } from 'node:http'

      import DatabaseConstructor from 'better-sqlite3'
      import {
        openRegistry,
        scanWorkspace,
        verifyWorkspace,
        startUiServer,
      } from 'urtext'

      const git = (root, ...args) => {
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr)
      }

      const root = mkdtempSync(join(tmpdir(), 'urtext-consumer-workspace-'))
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@urtext.dev')
      git(root, 'config', 'user.name', 'test')
      mkdirSync(join(root, 'specs/x'), { recursive: true })
      writeFileSync(join(root, 'specs/x/spec.md'), '## C001 guarded <!-- oracle:cmd:true risk:high -->\\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'baseline')

      const db = new DatabaseConstructor(':memory:')
      openRegistry(db)
      scanWorkspace(db, root)
      verifyWorkspace(db, root)

      const server = await startUiServer(db, root, { port: 0, open: false, decider: 'consumer-fixture' })

      const get = (path) => new Promise((resolve, reject) => {
        const req = request(server.url + path, { method: 'GET', headers: { host: server.url.replace('http://', '') } }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        req.end()
      })

      // Three renderers, exercised through the real HTTP surface:
      // renderConsolePage (/), renderBriefPage (/brief?spec=&clause=), renderBriefErrorPage (unknown clause).
      const consoleRes = await get('/')
      const briefRes = await get('/brief?spec=specs%2Fx%2Fspec.md&clause=C001')
      const briefErrorRes = await get('/brief?spec=specs%2Fx%2Fspec.md&clause=C999')
      server.close()

      if (consoleRes.status !== 200 || !consoleRes.body.includes('<html')) {
        throw new Error('console renderer missing 200 <html>: ' + consoleRes.status)
      }
      if (briefRes.status !== 200 || !briefRes.body.includes('<html')) {
        throw new Error('brief renderer missing 200 <html>: ' + briefRes.status)
      }
      if (!briefErrorRes.body.includes('<html')) {
        throw new Error('brief-error renderer missing <html>: ' + briefErrorRes.status)
      }

      let deepImportRejected = false
      try {
        await import('urtext/dist/registry.js')
      } catch (err) {
        deepImportRejected = err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      }

      rmSync(root, { recursive: true, force: true })
      console.log(JSON.stringify({ ok: true, status: consoleRes.status, deepImportRejected }))
    `
    writeFileSync(join(consumerDir, 'runtime-check.mjs'), script)
    const result = spawnSync('node', ['runtime-check.mjs'], { cwd: consumerDir, encoding: 'utf8' })
    expect(result.stderr + result.stdout).not.toContain('Error:')
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout.trim())
    expect(parsed.ok).toBe(true)
    expect(parsed.status).toBe(200)
    expect(parsed.deepImportRejected).toBe(true)
  }, 30_000)
})

describe('installed type consumer', () => {
  test('the installed package resolves .d.ts types through the "." export condition', () => {
    const consumerTsconfig = {
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['type-check.ts'],
    }
    writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify(consumerTsconfig, null, 2))
    writeFileSync(
      join(consumerDir, 'type-check.ts'),
      `import { openRegistry, type UiSnapshot } from 'urtext'\nconst fn: (s: UiSnapshot) => void = () => {}\nvoid openRegistry\nvoid fn\n`
    )
    const tsc = join(REPO_ROOT, 'node_modules/.bin/tsc')
    const result = spawnSync(tsc, ['--noEmit', '-p', 'tsconfig.json'], { cwd: consumerDir, encoding: 'utf8' })
    expect(result.stdout + result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  test('a deep subpath import is rejected at the type level (no matching export)', () => {
    writeFileSync(join(consumerDir, 'type-check-deep.ts'), `import {} from 'urtext/dist/registry.js'\n`)
    const consumerTsconfig = JSON.parse(readFileSync(join(consumerDir, 'tsconfig.json'), 'utf8'))
    consumerTsconfig.include = ['type-check-deep.ts']
    writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify(consumerTsconfig, null, 2))
    const tsc = join(REPO_ROOT, 'node_modules/.bin/tsc')
    const result = spawnSync(tsc, ['--noEmit', '-p', 'tsconfig.json'], { cwd: consumerDir, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
  })
})
