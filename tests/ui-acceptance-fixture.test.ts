import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

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

const observedDiffFingerprint = (root: string, baselineSha: string, filePath: string): string => {
  const result = spawnSync('git', ['diff', '--unified=0', baselineSha, '--', filePath], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || `git diff failed for ${filePath}`)
  const lines = result.stdout.split('\n')
  const header = lines.findIndex((line) => line.startsWith('@@ '))
  if (header < 0) throw new Error(`no observed diff hunk for ${filePath}`)
  const fingerprintInput = lines
    .slice(header)
    .filter((line, index) => index === 0 || /^(?:[+-]|\\)/.test(line))
    .join('\n')
  return createHash('sha256').update(fingerprintInput).digest('hex')
}

let repeatHandleA: FixtureHandle | undefined
let repeatHandleB: FixtureHandle | undefined
let fixtureBaseline: FixtureHandle | undefined

beforeAll(() => {
  const originalCwd = process.cwd()
  process.chdir(tmpdir())
  try {
    fixtureBaseline = setupFixture()
  } finally {
    process.chdir(originalCwd)
  }
  repeatHandleA = buildFixture(mkdtempSync(join(tmpdir(), 'urtext-ui-acceptance-a-')))
  repeatHandleB = buildFixture(mkdtempSync(join(tmpdir(), 'urtext-ui-acceptance-b-')))
}, 30_000)

afterAll(() => {
  for (const fixture of [fixtureBaseline, repeatHandleA, repeatHandleB]) {
    if (fixture) cleanupFixture(fixture)
  }
})

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const baselineFixture = (): FixtureHandle => {
  if (fixtureBaseline === undefined) throw new Error('baseline fixture was not built')
  return fixtureBaseline
}

describe('S4 acceptance fixture — setup/cleanup/repeatability', () => {
  test('baseline fixture is self-contained and stable from an arbitrary process cwd', () => {
    const fixture = baselineFixture()
    expect(existsSync(join(fixture.root, '.git'))).toBe(true)
    expect(existsSync(join(fixture.root, '.urtext/registry.sqlite'))).toBe(true)
    expect(fixture.targets).toEqual({
      manual: 'specs/demo/spec.md#C003',
      reviewable: 'specs/demo/spec.md#C004',
      dependentSource: 'specs/demo/spec.md#C001',
      dependent: 'specs/demo/spec.md#C002',
      stale: 'specs/demo/spec.md#C002',
      unmappedFile: 'unmapped.txt',
    })
    expect(worktreeDirty(fixture.root)).toBe(false)
  })

  test('cleanup deletes an isolated root and remains idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-ui-acceptance-cleanup-'))
    const db = new DatabaseConstructor(join(root, 'registry.sqlite'))
    cleanupFixture({ root, db })
    expect(existsSync(root)).toBe(false)
    expect(() => rmSync(root, { recursive: true, force: true })).not.toThrow()
  })

  test('independent roots produce byte-identical shas and target keys', () => {
    if (repeatHandleA === undefined || repeatHandleB === undefined) throw new Error('repeatability fixtures were not built')
    expect(repeatHandleA.mappingBaselineSha).toBe(repeatHandleB.mappingBaselineSha)
    expect(repeatHandleA.implementationSha).toBe(repeatHandleB.implementationSha)
    expect(repeatHandleA.targets).toEqual(repeatHandleB.targets)
    expect(repeatHandleA.root).not.toBe(repeatHandleB.root)
  })

  test('fixture exposes exactly FR002 as uncovered intent', () => {
    const fixture = baselineFixture()
    const status = buildStatus(fixture.db, { head: null, unmapped: [] })
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
    const handle = baselineFixture()
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
    const provenance = handle.db
      .prepare(
        `SELECT file_path AS filePath, commit_sha AS commitSha, diff_fingerprint AS diffFingerprint
         FROM clause_code_map
         WHERE kind = 'clause' AND spec_path = 'specs/demo/spec.md' AND clause_id = 'C004'
         ORDER BY file_path`
      )
      .all() as { filePath: string; commitSha: string; diffFingerprint: string | null }[]
    expect(provenance).toHaveLength(5)
    for (const mapping of provenance) {
      expect(mapping.commitSha).toBe(handle.mappingBaselineSha)
      expect(mapping.diffFingerprint).toBe(
        observedDiffFingerprint(handle.root, handle.mappingBaselineSha, mapping.filePath)
      )
    }
    expect(worktreeDirty(handle.root)).toBe(false)
  })

  test('dependent/dependentSource/manual targets resolve to the expected clauses', () => {
    const handle = baselineFixture()
    const dependentSource = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C001')
    const dependent = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C002')
    const manual = handleBrief(handle.db, handle.root, 'specs/demo/spec.md', 'C003')
    for (const result of [dependentSource, dependent, manual]) {
      if (!('ok' in result.body) || !result.body.ok) throw new Error('expected an ok brief body')
    }
    if (!('risk' in manual.body) || !('reviewable' in manual.body)) throw new Error('expected manual brief facts')
    expect(manual.body.risk).toBe('low')
    expect(manual.body.reviewable).toBe(false)
  })

  test('C002 carries the real C001 invalidation source after the third commit', () => {
    const handle = baselineFixture()
    const row = handle.db
      .prepare(
        `SELECT invalidated_at, invalidation_source FROM evidence
         WHERE spec_path = 'specs/demo/spec.md' AND clause_id = 'C002'
         ORDER BY id DESC LIMIT 1`
      )
      .get() as { invalidated_at: number | null; invalidation_source: string | null }
    expect(row.invalidated_at).not.toBeNull()
    expect(row.invalidation_source).toBe('specs/demo/spec.md#C001')
  })
})

describe('S4 acceptance fixture — unmapped hunk toggle stays clean-tree provable', () => {
  test('mutating and restoring the baseline unmapped file round-trips worktreeDirty exactly', () => {
    const handle = baselineFixture()
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
