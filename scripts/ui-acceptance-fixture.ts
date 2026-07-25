#!/usr/bin/env node
/**
 * S4 deterministic temporary Git/registry fixture (urtext-20260724-ui-redesign
 * §8.2). Builds a throwaway repo under an `mkdtempSync` root with demo
 * clauses spanning evidence/audit/manual states, five real `old → new`
 * mapping-range diffs on a clean HEAD, and a local agent-stub bundle — the
 * substrate `tests/ui-acceptance-fixture.test.ts` and the future browser
 * acceptance matrix drive. Never mutates the calling repo; every path is
 * resolved absolutely so the fixture works from any process cwd.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import DatabaseConstructor, { type Database } from 'better-sqlite3'

import {
  openRegistry,
  scanWorkspace,
  verifyWorkspace,
  exportRequest,
  importVerdicts,
  recordMapping,
  worktreeDirty,
} from '../src/index.js'
import { TRANSPORTS, type Transport } from './ui-agent-stub.js'

const DEMO_SPEC = `## C001 low runnable base <!-- oracle:cmd:true risk:low -->
Foundational demo clause with no dependencies; evidence and audit both agree.

## C002 low dependent on base <!-- oracle:cmd:true risk:low refs:specs/demo/spec.md#C001 -->
Depends on C001 remaining verified; evidence and audit both agree.

## C003 low manual pending decision <!-- oracle:manual risk:low -->
Requires a human manual pass/fail; the fixture leaves it undecided.

## C004 high review target <!-- oracle:cmd:true risk:high -->
High-risk clause whose five implementation files carry real mapped diffs.

## C005 low agent prerequisite <!-- oracle:cmd:true risk:low -->
Evidence exists but is never imported through the audit ledger, keeping it
unaudited so the agent lane stays non-empty.
`

const IMPL_FILE_COUNT = 5
/** 1-based line inside each implementation file the C004 mappings claim. */
const MAPPING_LINE = 3
const UNMAPPED_BASELINE = 'baseline unmapped content\n'
const UNMAPPED_MUTATED = 'baseline unmapped content\nan uncommitted tracked change\n'

const implFilePath = (n: number): string => `specs/demo/impl-${n}.ts`

const implFileContent = (n: number, updated: boolean): string => {
  const base = updated
    ? `  const base = ${n} + 1 // updated by acceptance fixture mapping ${n}`
    : `  const base = ${n}`
  return [
    `export const step${n} = (): number => {`,
    `  // baseline behavior for mapping fixture ${n}`,
    base,
    `  const scaled = base * 1`,
    `  return scaled`,
    `}`,
    '',
  ].join('\n')
}

const runGit = (root: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${root}: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

/** Fixed commit date so `git commit` shas are reproducible across roots —
 * timestamps are the only otherwise-nondeterministic input to a commit sha. */
const FIXTURE_COMMIT_DATE = '2024-01-01T00:00:00Z'

const runGitCommit = (root: string, message: string): void => {
  const result = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE, GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE },
  })
  if (result.status !== 0) {
    throw new Error(`git commit -m "${message}" failed in ${root}: ${result.stderr || result.stdout}`)
  }
}

export interface FixtureTargets {
  manual: string
  reviewable: string
  dependentSource: string
  dependent: string
  unmappedFile: string
}

export interface FixtureHandle {
  root: string
  db: Database
  targets: FixtureTargets
  mappingBaselineSha: string
  implementationSha: string
}

const FIXTURE_TARGETS: FixtureTargets = {
  manual: 'specs/demo/spec.md#C003',
  reviewable: 'specs/demo/spec.md#C004',
  dependentSource: 'specs/demo/spec.md#C001',
  dependent: 'specs/demo/spec.md#C002',
  unmappedFile: 'unmapped.txt',
}

/**
 * Build the fixture at an already-created empty `root` directory. Split from
 * `setupFixture` so tests can pin an explicit root (e.g. to prove the build
 * is deterministic across two independent roots).
 */
export const buildFixture = (root: string): FixtureHandle => {
  mkdirSync(join(root, 'specs/demo'), { recursive: true })
  runGit(root, ['init', '-q'])
  runGit(root, ['config', 'user.email', 'fixture@urtext.dev'])
  runGit(root, ['config', 'user.name', 'urtext-ui-acceptance-fixture'])

  writeFileSync(join(root, '.gitignore'), '.urtext/\n')
  writeFileSync(join(root, 'specs/demo/spec.md'), DEMO_SPEC)
  for (let n = 1; n <= IMPL_FILE_COUNT; n += 1) {
    writeFileSync(join(root, implFilePath(n)), implFileContent(n, false))
  }
  writeFileSync(join(root, 'unmapped.txt'), UNMAPPED_BASELINE)

  runGit(root, ['add', '-A'])
  runGitCommit(root, 'baseline')
  const mappingBaselineSha = runGit(root, ['rev-parse', 'HEAD'])

  mkdirSync(join(root, '.urtext'), { recursive: true })
  const db = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'))
  openRegistry(db)
  scanWorkspace(db, root)
  verifyWorkspace(db, root)

  const timestamp = Date.now()
  const auditedClauseIds = new Set(['C001', 'C002', 'C004'])
  const request = exportRequest(db)
  const verdicts = request.items
    .filter((item) => item.specPath === 'specs/demo/spec.md' && auditedClauseIds.has(item.clauseId))
    .map((item) => ({ evidenceId: item.evidenceId, auditor: 'acceptance-fixture', verdict: 'agree' as const }))
  if (verdicts.length !== auditedClauseIds.size) {
    db.close()
    throw new Error(`expected ${auditedClauseIds.size} auditable clauses, found ${verdicts.length}`)
  }
  const imported = importVerdicts(db, verdicts, timestamp)
  if (imported.kind !== 'imported') {
    db.close()
    throw new Error(`importVerdicts failed: ${imported.message}`)
  }

  for (let n = 1; n <= IMPL_FILE_COUNT; n += 1) {
    const filePath = implFilePath(n)
    writeFileSync(join(root, filePath), implFileContent(n, true))
    const outcome = recordMapping(
      db,
      { specPath: 'specs/demo/spec.md', clauseId: 'C004', filePath, lineStart: MAPPING_LINE, lineEnd: MAPPING_LINE },
      root,
      timestamp
    )
    if (outcome.kind !== 'mapped') {
      db.close()
      throw new Error(`recordMapping failed for ${filePath}: ${JSON.stringify(outcome)}`)
    }
  }

  runGit(root, ['add', '-A'])
  runGitCommit(root, 'implementation: update demo mapping ranges')
  const implementationSha = runGit(root, ['rev-parse', 'HEAD'])

  if (worktreeDirty(root) !== false) {
    db.close()
    throw new Error('fixture worktree must be clean after the implementation commit')
  }

  return { root, db, mappingBaselineSha, implementationSha, targets: FIXTURE_TARGETS }
}

/** Create a fresh `mkdtempSync` root and build the fixture inside it. */
export const setupFixture = (): FixtureHandle => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-ui-acceptance-'))
  return buildFixture(root)
}

/** Idempotent teardown: closes the db handle, deletes the root, and never
 * throws if the root is already gone (matrix scenarios may end mid-run). */
export const cleanupFixture = (handle: Pick<FixtureHandle, 'root' | 'db'>): void => {
  handle.db.close()
  rmSync(handle.root, { recursive: true, force: true })
}

/** Matrix #5 (§8.2 item 5): mutate the tracked `unmapped.txt` hunk. */
export const mutateUnmappedFile = (root: string): void => {
  writeFileSync(join(root, 'unmapped.txt'), UNMAPPED_MUTATED)
}

/** Restore `unmapped.txt` to its exact baseline bytes, re-cleaning the tree. */
export const restoreUnmappedFile = (root: string): void => {
  writeFileSync(join(root, 'unmapped.txt'), UNMAPPED_BASELINE)
}

export interface AccBuildPaths {
  outDir: string
  fixtureEntry: string
  stubEntry: string
}

/**
 * Compile the acceptance-only TypeScript (this file + `ui-agent-stub.ts` +
 * the domain `src/`) to an external `outDir` via the repository-local `tsc`
 * binary — never `dist/`, never a repo-internal path (§8.2, P1 ACCEPTANCE-
 * OUTDIR). Callers own choosing and cleaning up `outDir`.
 */
export const compileAccBuild = (outDir: string): AccBuildPaths => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const tsc = join(repoRoot, 'node_modules/.bin/tsc')
  const tsconfig = join(repoRoot, 'scripts/tsconfig.ui-acceptance.json')
  if (!existsSync(tsc)) throw new Error(`repository-local tsc not found at ${tsc}`)
  const result = spawnSync(tsc, ['-p', tsconfig, '--outDir', outDir], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`acceptance TypeScript check failed:\n${result.stdout}\n${result.stderr}`)
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
  symlinkSync(join(repoRoot, 'node_modules'), join(outDir, 'node_modules'), 'dir')
  return {
    outDir,
    fixtureEntry: join(outDir, 'scripts/ui-acceptance-fixture.js'),
    stubEntry: join(outDir, 'scripts/ui-agent-stub.js'),
  }
}


export interface AgentStubBundle {
  binDir: string
  homeDir: string
  logPath: string
  wrappers: Record<Transport, string>
}

/** POSIX single-quote a literal for safe inclusion inside a `sh` command. */
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Build `<root>/.urtext/ui-agent-stubs/`: four `0700` wrapper scripts, an
 * external redacted-log sink, and an isolated HOME. Each wrapper is exactly
 * `#!/bin/sh` + one `exec` line with POSIX-quoted trusted literals; runtime
 * argv only ever crosses via `"$@"` — no eval, no command string, no `$*`.
 */
export const createAgentStubBundle = (
  root: string,
  helperPath: string,
  nodePath: string = process.execPath
): AgentStubBundle => {
  const absoluteNode = realpathSync(nodePath)
  const absoluteHelper = realpathSync(helperPath)
  const binDir = join(root, '.urtext/ui-agent-stubs/bin')
  const homeDir = join(root, '.urtext/ui-agent-stubs/home')
  const logPath = join(root, '.urtext/ui-agent-stubs/invocations.log')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  writeFileSync(logPath, '')

  const wrappers = {} as Record<Transport, string>
  for (const transport of TRANSPORTS) {
    const wrapperPath = join(binDir, transport)
    writeFileSync(wrapperPath, '#!/bin/sh\nexit 90\n')
    chmodSync(wrapperPath, 0o700)
    const wrapperRealpath = realpathSync(wrapperPath)
    const script = `#!/bin/sh\nexec ${shQuote(absoluteNode)} ${shQuote(absoluteHelper)} --transport ${shQuote(transport)} --stub-realpath ${shQuote(wrapperRealpath)} "$@"\n`
    writeFileSync(wrapperPath, script)
    chmodSync(wrapperPath, 0o700)
    wrappers[transport] = wrapperPath
  }

  return { binDir, homeDir, logPath, wrappers }
}
const isMain = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

if (isMain()) {
  const args = process.argv.slice(2)
  const cleanupIndex = args.indexOf('--cleanup')
  if (cleanupIndex >= 0) {
    const target = args[cleanupIndex + 1]
    if (!target) {
      process.stderr.write('ui-acceptance-fixture: --cleanup requires <root>\n')
      process.exit(2)
    }
    rmSync(target, { recursive: true, force: true })
    if (existsSync(target)) {
      process.stderr.write(`ui-acceptance-fixture: cleanup failed, ${target} still exists\n`)
      process.exit(1)
    }
    process.stdout.write(`${JSON.stringify({ ok: true, cleaned: target })}\n`)
  } else {
    const rootIndex = args.indexOf('--root')
    const explicitRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined
    const root = explicitRoot ?? mkdtempSync(join(tmpdir(), 'urtext-ui-acceptance-'))
    const handle = buildFixture(root)
    process.stdout.write(
      `${JSON.stringify({
        root: handle.root,
        targets: handle.targets,
        mappingBaselineSha: handle.mappingBaselineSha,
        implementationSha: handle.implementationSha,
      })}\n`
    )
    handle.db.close()
  }
}
