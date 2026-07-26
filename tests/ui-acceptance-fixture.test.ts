import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildStatus, handleBrief } from '../src/index.js'
import {
  buildFixture,
  cleanupFixture,
  compileAccBuild,
  createAgentStubBundle,
  mutateUnmappedFile,
  restoreUnmappedFile,
  setupFixture,
  type FixtureHandle,
} from '../scripts/ui-acceptance-fixture.js'
import { MODES, TRANSPORTS } from '../scripts/ui-agent-stub.js'

const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

const worktreeDirty = (root: string): boolean => {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  return result.stdout.trim().length > 0
}

let handle: FixtureHandle | undefined

afterEach(() => {
  if (handle) {
    cleanupFixture(handle)
    handle = undefined
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('S4 acceptance fixture — setup/cleanup/repeatability', () => {
  test('builds a self-contained repo + registry from an arbitrary process cwd', () => {
    const originalCwd = process.cwd()
    process.chdir(tmpdir())
    try {
      handle = setupFixture()
    } finally {
      process.chdir(originalCwd)
    }
    expect(existsSync(join(handle.root, '.git'))).toBe(true)
    expect(existsSync(join(handle.root, '.urtext/registry.sqlite'))).toBe(true)
    expect(handle.targets).toEqual({
      manual: 'specs/demo/spec.md#C003',
      reviewable: 'specs/demo/spec.md#C004',
      dependentSource: 'specs/demo/spec.md#C001',
      dependent: 'specs/demo/spec.md#C002',
      unmappedFile: 'unmapped.txt',
    })
    expect(worktreeDirty(handle.root)).toBe(false)
  })

  test('cleanup deletes the root and is safe to call twice', () => {
    handle = setupFixture()
    const root = handle.root
    cleanupFixture(handle)
    handle = undefined
    expect(existsSync(root)).toBe(false)
    // Idempotent: a second removal of an already-gone root must not throw.
    expect(() => rmSync(root, { recursive: true, force: true })).not.toThrow()
  })

  test('two independent roots build byte-identical shas and target keys', () => {
    const rootA = scratch('urtext-ui-acceptance-a-')
    const rootB = scratch('urtext-ui-acceptance-b-')
    const handleA = buildFixture(rootA)
    const handleB = buildFixture(rootB)
    try {
      expect(handleA.mappingBaselineSha).toBe(handleB.mappingBaselineSha)
      expect(handleA.implementationSha).toBe(handleB.implementationSha)
      expect(handleA.targets).toEqual(handleB.targets)
      expect(handleA.root).not.toBe(handleB.root)
    } finally {
      cleanupFixture(handleA)
      cleanupFixture(handleB)
    }
  }, 15000)

  test('fixture exposes exactly FR002 as uncovered intent', () => {
    handle = setupFixture()
    const status = buildStatus(handle.db, { head: null, unmapped: [] })
    expect(status.counts.uncovered).toBe(1)
    expect(status.uncoveredRequirements).toEqual([
      {
        specPath: 'specs/demo/spec.md',
        reqId: 'FR002',
        title: 'acceptance fixture uncovered intent',
      },
    ])
  })
})

describe('S4 acceptance fixture — five real mapping diffs', () => {
  test('C004 brief shows exactly five clean ASCII old/new diffs on a clean HEAD', () => {
    handle = setupFixture()
    const result = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C004')
    expect(result.status).toBe(200)
    if (!('ok' in result.body) || !result.body.ok) throw new Error('expected an ok brief body')
    expect(result.body.reviewable).toBe(true)
    expect(result.body.risk).toBe('high')
    const mappings = result.body.view.mappings
    expect(mappings).toHaveLength(5)
    for (const mapping of mappings) {
      expect(mapping.diffError).toBeNull()
      expect(mapping.diff).toContain('-  const base')
      expect(mapping.diff).toContain('+  const base')
      expect(mapping.diff).toContain('updated by acceptance fixture')
      expect(mapping.lineStart).toBeLessThanOrEqual(mapping.lineEnd)
    }
    expect(worktreeDirty(handle.root)).toBe(false)
  })

  test('dependent/dependentSource/manual targets resolve to the expected clauses', () => {
    handle = setupFixture()
    const dependentSource = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C001')
    const dependent = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C002')
    const manual = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C003')
    for (const result of [dependentSource, dependent, manual]) {
      if (!('ok' in result.body) || !result.body.ok) throw new Error('expected an ok brief body')
    }
    expect((manual.body as { risk: string }).risk).toBe('low')
    expect((manual.body as { reviewable: boolean }).reviewable).toBe(false)
  })
})

describe('S4 acceptance fixture — unmapped hunk toggle stays clean-tree provable', () => {
  test('mutating and restoring unmapped.txt round-trips worktreeDirty exactly', () => {
    handle = setupFixture()
    expect(worktreeDirty(handle.root)).toBe(false)
    mutateUnmappedFile(handle.root)
    expect(worktreeDirty(handle.root)).toBe(true)
    restoreUnmappedFile(handle.root)
    expect(worktreeDirty(handle.root)).toBe(false)
    expect(readFileSync(join(handle.root, 'unmapped.txt'), 'utf8')).toBe('baseline unmapped content\n')
  })
})

describe('S4 acceptance — external ACC_BUILD TypeScript check', () => {
  test('compiled fixture runs from an arbitrary cwd with the approved local dependency closure', () => {
    const outDir = scratch('urtext-acc-build-')
    const paths = compileAccBuild(outDir)
    const fixtureRoot = join(scratch('urtext-compiled-fixture-'), 'fixture')
    const result = spawnSync(process.execPath, [paths.fixtureEntry, '--root', fixtureRoot], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ root: fixtureRoot })
    expect(existsSync(join(fixtureRoot, '.urtext/registry.sqlite'))).toBe(true)
  }, 30000)

  test('compiled browser checker executes its CLI guard from an external build', () => {
    const outDir = scratch('urtext-browser-build-')
    compileAccBuild(outDir)
    const entry = join(outDir, 'scripts/ui-browser-check.js')
    const result = spawnSync(process.execPath, [entry], { cwd: tmpdir(), encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: ui-browser-check.js')
  })

  test('compiles fixture + stub entries to an external outDir with zero repo/dist artifacts', () => {
    const outDir = scratch('urtext-acc-build-')
    const paths = compileAccBuild(outDir)
    expect(existsSync(paths.fixtureEntry)).toBe(true)
    expect(existsSync(paths.stubEntry)).toBe(true)
    expect(existsSync(join(outDir, 'package.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    // repo/dist must stay untouched by the acceptance-only build.
    expect(existsSync(join(process.cwd(), 'dist/scripts'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'scripts/ui-acceptance-fixture.js'))).toBe(false)
  })
})

describe('S4 acceptance — compiled local agent stub bundle', () => {
  const runWrapper = (
    wrapperPath: string,
    mode: string,
    env: NodeJS.ProcessEnv
  ): { status: number | null; stdout: string } => {
    const result = spawnSync(wrapperPath, ['--mode', mode], { encoding: 'utf8', env })
    return { status: result.status, stdout: result.stdout }
  }

  test('four wrappers × two modes (eight combinations) return fixed deterministic JSON', () => {
    const outDir = scratch('urtext-acc-build-stub-')
    const paths = compileAccBuild(outDir)
    const root = scratch('urtext-ui-acceptance-stub-')
    const bundle = createAgentStubBundle(root, paths.stubEntry)

    expect(Object.keys(bundle.wrappers)).toEqual([...TRANSPORTS])
    for (const transport of TRANSPORTS) {
      const wrapperPath = bundle.wrappers[transport]
      expect(statSync(wrapperPath).mode & 0o777).toBe(0o700)
      for (const mode of MODES) {
        const { status, stdout } = runWrapper(wrapperPath, mode, {
          PATH: process.env.PATH,
          HOME: bundle.homeDir,
          URTEXT_STUB_LOG: bundle.logPath,
        })
        expect(status).toBe(0)
        const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
        if (mode === 'audit') expect(typeof parsed.verdict).toBe('string')
        else expect(typeof parsed.explanation).toBe('string')
      }
    }

    const logLines = readFileSync(bundle.logPath, 'utf8').trim().split('\n')
    expect(logLines).toHaveLength(TRANSPORTS.length * MODES.length)
    for (const line of logLines) {
      const entry = JSON.parse(line) as Record<string, unknown>
      expect(Object.keys(entry).sort()).toEqual(
        ['argvCount', 'delayedMs', 'mode', 'pid', 'transport', 'ts', 'wrapperRealpath'].sort()
      )
      expect(entry.delayedMs).toBe(0)
      expect(TRANSPORTS as readonly string[]).toContain(entry.transport)
    }
  })

  test('URTEXT_STUB_DELAY_MS=750 measurably delays the wrapper and is logged', () => {
    const outDir = scratch('urtext-acc-build-delay-')
    const paths = compileAccBuild(outDir)
    const root = scratch('urtext-ui-acceptance-delay-')
    const bundle = createAgentStubBundle(root, paths.stubEntry)

    const started = Date.now()
    const { status, stdout } = runWrapper(bundle.wrappers.claude, 'audit', {
      PATH: process.env.PATH,
      HOME: bundle.homeDir,
      URTEXT_STUB_LOG: bundle.logPath,
      URTEXT_STUB_DELAY_MS: '750',
    })
    const elapsed = Date.now() - started
    expect(status).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(700)
    expect(JSON.parse(stdout.trim())).toEqual({ verdict: 'agree', note: 'stub claude audit: evidence covers clause' })
    const lastLine = readFileSync(bundle.logPath, 'utf8').trim().split('\n').at(-1)!
    expect(JSON.parse(lastLine).delayedMs).toBe(750)
  })

  test('wrapper scripts never embed eval, $*, or literal argv content', () => {
    const outDir = scratch('urtext-acc-build-quote-')
    const paths = compileAccBuild(outDir)
    const root = scratch('urtext-ui-acceptance-quote-')
    const bundle = createAgentStubBundle(root, paths.stubEntry)
    for (const wrapperPath of Object.values(bundle.wrappers)) {
      const content = readFileSync(wrapperPath, 'utf8')
      expect(content.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
      expect(content.startsWith('#!/bin/sh\n')).toBe(true)
      expect(content).toContain('exec ')
      expect(content).toContain('"$@"')
      expect(content).not.toContain('eval')
      expect(content).not.toContain('$*')
    }
  })
})
