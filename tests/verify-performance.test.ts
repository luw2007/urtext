import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []
const originalBatchSetting = process.env.URTEXT_VERIFY_BATCH

interface WorkspaceOptions {
  clauses: string[]
  tests?: Record<string, string>
  withVitest?: boolean
  git?: boolean
}

const makeWorkspace = ({
  clauses,
  tests = {},
  withVitest = true,
  git = false,
}: WorkspaceOptions): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-verify-performance-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(
    join(root, 'specs/x/spec.md'),
    ['## FR001 test intent', '', ...clauses.flatMap((clause) => [clause, ''])].join('\n')
  )
  for (const [path, content] of Object.entries(tests)) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  if (withVitest) symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.email=urtext@example.invalid',
        '-c',
        'user.name=Urtext Test',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root }
    )
  }
  scanWorkspace(db, root)
  return root
}

const passingTest = (name: string): string => `
import { expect, test } from 'vitest'

test('${name}', () => {
  expect(true).toBe(true)
})
`

const failingTest = (name: string): string => `
import { expect, test } from 'vitest'

test('${name}', () => {
  expect(true).toBe(false)
})
`

const evidenceCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
  delete process.env.URTEXT_VERIFY_BATCH
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  if (originalBatchSetting === undefined) delete process.env.URTEXT_VERIFY_BATCH
  else process.env.URTEXT_VERIFY_BATCH = originalBatchSetting
})

describe('batched test oracles', () => {
  test('an unmatched ref fails while a matching sibling still passes', () => {
    const root = makeWorkspace({
      clauses: [
        '## C001 passing <!-- oracle:test:tests/pass.test.ts req:FR001 -->',
        '## C002 missing <!-- oracle:test:tests/missing.test.ts req:FR001 -->',
      ],
      tests: { 'tests/pass.test.ts': passingTest('passes') },
    })

    const report = verifyWorkspace(db, root)

    expect(report.verdicts.map(({ clauseId, verdict }) => ({ clauseId, verdict }))).toEqual([
      { clauseId: 'C001', verdict: 'pass' },
      { clauseId: 'C002', verdict: 'fail' },
    ])
    expect(report.verdicts[1]!.output).toContain('no test file matched ref')
  })

  test('substring refs aggregate every matching file and fail if any file fails', () => {
    const root = makeWorkspace({
      clauses: ['## C001 shared prefix <!-- oracle:test:tests/shared- req:FR001 -->'],
      tests: {
        'tests/shared-pass.test.ts': passingTest('shared pass'),
        'tests/shared-fail.test.ts': failingTest('shared fail'),
      },
    })

    const verdict = verifyWorkspace(db, root).verdicts[0]!

    expect(verdict.verdict).toBe('fail')
    expect(verdict.output).toContain('shared pass')
    expect(verdict.output).toContain('shared fail')
  })

  test('grouped and solo execution produce identical clause verdict tuples', () => {
    const root = makeWorkspace({
      clauses: [
        '## C001 passing <!-- oracle:test:tests/pass.test.ts req:FR001 -->',
        '## C002 failing <!-- oracle:test:tests/fail.test.ts req:FR001 -->',
      ],
      tests: {
        'tests/pass.test.ts': passingTest('passes'),
        'tests/fail.test.ts': failingTest('fails'),
      },
    })
    const tuples = () => {
      verifyWorkspace(db, root)
      return db
        .prepare(
          `SELECT clause_id AS clauseId, verdict, exit_code AS exitCode
           FROM evidence ORDER BY id DESC LIMIT 2`
        )
        .all()
        .reverse()
    }

    const grouped = tuples()
    process.env.URTEXT_VERIFY_BATCH = '0'
    const solo = tuples()

    expect(solo).toEqual(grouped)
  })

  test('a missing local vitest fails every ref closed and records every clause', () => {
    const root = makeWorkspace({
      clauses: [
        '## C001 first <!-- oracle:test:tests/first.test.ts req:FR001 -->',
        '## C002 second <!-- oracle:test:tests/second.test.ts req:FR001 -->',
      ],
      withVitest: false,
    })

    const report = verifyWorkspace(db, root)

    expect(report.verdicts.map((verdict) => verdict.verdict)).toEqual(['fail', 'fail'])
    expect(report.verdicts.every((verdict) => verdict.output.includes('no dynamic install fallback'))).toBe(true)
    expect(evidenceCount()).toBe(2)
  })
  test('a vitest that writes no report fails every ref closed', () => {
    const root = makeWorkspace({
      clauses: ['## C001 first <!-- oracle:test:tests/first.test.ts req:FR001 -->'],
      withVitest: false,
    })
    const binDir = join(root, 'node_modules/.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'vitest'), '#!/bin/sh\necho broken >&2\nexit 1\n', { mode: 0o755 })

    const report = verifyWorkspace(db, root)

    expect(report.verdicts[0]!.verdict).toBe('fail')
    expect(report.verdicts[0]!.output).toContain('vitest batch produced no JSON report')
  })

  test('a red exit code without an attributable file failure fails every ref', () => {
    const root = makeWorkspace({
      clauses: ['## C001 leaky <!-- oracle:test:tests/leaky.test.ts req:FR001 -->'],
      tests: {
        'tests/leaky.test.ts': `
import { expect, test } from 'vitest'

setTimeout(() => Promise.reject(new Error('boom')), 30)

test('passes but leaks', async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(true).toBe(true)
})
`,
      },
    })

    const report = verifyWorkspace(db, root)

    expect(report.verdicts[0]!.verdict).toBe('fail')
    expect(report.verdicts[0]!.output).toContain('without an attributable file failure')
  })
  test('a pass attributed out of a red batch is never stamped reusable', () => {
    const root = makeWorkspace({
      clauses: [
        '## C001 leaky <!-- oracle:test:tests/leaky.test.ts req:FR001 -->',
        '## C002 broken <!-- oracle:test:tests/broken.test.ts req:FR001 -->',
      ],
      tests: {
        'tests/leaky.test.ts': `
import { expect, test } from 'vitest'

setTimeout(() => Promise.reject(new Error('boom')), 30)

test('passes but leaks', async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(true).toBe(true)
})
`,
        'tests/broken.test.ts': failingTest('really fails'),
      },
      git: true,
    })

    const report = verifyWorkspace(db, root)

    // The sibling's real failure explains the exit code, so per-clause
    // attribution keeps the leaky file green — but its row must carry a NULL
    // fingerprint so incremental can never serve the potentially-lying pass.
    expect(report.verdicts.map(({ clauseId, verdict }) => ({ clauseId, verdict }))).toEqual([
      { clauseId: 'C001', verdict: 'pass' },
      { clauseId: 'C002', verdict: 'fail' },
    ])
    const fingerprints = db
      .prepare('SELECT clause_id AS clauseId, input_fingerprint AS fp FROM evidence ORDER BY clause_id')
      .all() as { clauseId: string; fp: string | null }[]
    expect(fingerprints.every(({ fp }) => fp === null)).toBe(true)

    const incremental = verifyWorkspace(db, root, undefined, { incremental: true })
    expect(incremental.reusedCount).toBe(0)
  })
})

describe('incremental evidence reuse', () => {
  test('a clean passing test reuses its row and marks the returned verdict', () => {
    const root = makeWorkspace({
      clauses: ['## C001 passing <!-- oracle:test:tests/pass.test.ts req:FR001 -->'],
      tests: { 'tests/pass.test.ts': passingTest('passes') },
      git: true,
    })

    const first = verifyWorkspace(db, root, undefined, { incremental: true })
    const second = verifyWorkspace(db, root, undefined, { incremental: true })
    const row = db.prepare('SELECT input_fingerprint FROM evidence').get() as {
      input_fingerprint: string | null
    }

    expect(first.verdicts[0]!.source).toBe('run')
    expect(second.reusedCount).toBe(1)
    expect(second.verdicts[0]!.source).toBe('reused')
    expect(evidenceCount()).toBe(1)
    expect(row.input_fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  test('invalidated evidence is executed again and appended', () => {
    const root = makeWorkspace({
      clauses: ['## C001 passing <!-- oracle:test:tests/pass.test.ts req:FR001 -->'],
      tests: { 'tests/pass.test.ts': passingTest('passes') },
      git: true,
    })
    verifyWorkspace(db, root, undefined, { incremental: true })
    db.prepare('UPDATE evidence SET invalidated_at = ?').run(Date.now())

    const report = verifyWorkspace(db, root, undefined, { incremental: true })

    expect(report.reusedCount).toBe(0)
    expect(report.verdicts[0]!.source).toBe('run')
    expect(evidenceCount()).toBe(2)
  })

  test('a tracked working-tree edit defeats reuse', () => {
    const root = makeWorkspace({
      clauses: ['## C001 passing <!-- oracle:test:tests/pass.test.ts req:FR001 -->'],
      tests: { 'tests/pass.test.ts': passingTest('passes') },
      git: true,
    })
    verifyWorkspace(db, root, undefined, { incremental: true })
    appendFileSync(join(root, 'tests/pass.test.ts'), '\n// tracked edit\n')

    const report = verifyWorkspace(db, root, undefined, { incremental: true })

    expect(report.reusedCount).toBe(0)
    expect(report.verdicts[0]!.source).toBe('run')
    expect(evidenceCount()).toBe(2)
  })

  test('a non-test oracle always executes and appends', () => {
    const root = makeWorkspace({
      clauses: ['## C001 command <!-- oracle:cmd:true req:FR001 -->'],
      git: true,
    })

    verifyWorkspace(db, root, undefined, { incremental: true })
    const report = verifyWorkspace(db, root, undefined, { incremental: true })

    expect(report.reusedCount).toBe(0)
    expect(report.verdicts[0]!.source).toBe('run')
    expect(evidenceCount()).toBe(2)
  })

  test('a failing test verdict always executes and appends', () => {
    const root = makeWorkspace({
      clauses: ['## C001 failing <!-- oracle:test:tests/fail.test.ts req:FR001 -->'],
      tests: { 'tests/fail.test.ts': failingTest('fails') },
      git: true,
    })

    verifyWorkspace(db, root, undefined, { incremental: true })
    const report = verifyWorkspace(db, root, undefined, { incremental: true })

    expect(report.counts.fail).toBe(1)
    expect(report.reusedCount).toBe(0)
    expect(report.verdicts[0]!.source).toBe('run')
    expect(evidenceCount()).toBe(2)
  })
})
