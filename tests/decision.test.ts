import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { currentHead, decisionsAtHead, listDecisions, recordDecision } from '../src/decision.js'
import { adjudicate } from '../src/gate.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A git repo with a manual C001 + runnable C002 (cmd:true), verified. */
const setupRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-decide-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(
    join(root, 'specs/x/spec.md'),
    ['## C001 design intent <!-- oracle:manual -->', '## C002 label <!-- oracle:cmd:true -->'].join('\n')
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  return root
}

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('recordDecision', () => {
  test('records a pass decision bound to HEAD for a manual clause', () => {
    const root = setupRepo()
    const outcome = recordDecision(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' },
      root,
      1
    )
    expect(outcome.kind).toBe('recorded')
    if (outcome.kind === 'recorded') expect(outcome.commitSha).toBe(currentHead(root))
  })

  test('rejects deciding a runnable-oracle clause (P2: objective oracle owns it)', () => {
    const root = setupRepo()
    const outcome = recordDecision(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C002', verdict: 'pass', decider: 'alice' },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'not_manual' })
  })

  test('rejects an unknown clause', () => {
    const root = setupRepo()
    const outcome = recordDecision(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C999', verdict: 'pass', decider: 'alice' },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'unknown_clause' })
  })
})

describe('listDecisions', () => {
  test('returns records newest first', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'fail', decider: 'a', note: 'first' }, root, 1)
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'a', note: 'second' }, root, 2)
    const records = listDecisions(db)
    expect(records.map((r) => r.note)).toEqual(['second', 'first'])
  })
})

describe('gate memory layer', () => {
  test('a manual clause with no decision needs a human', () => {
    const root = setupRepo()
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ decisionVerdict: 'none', decision: 'human' })
    expect(c001?.reasons).toContain('manual clause undecided — `urtext decide`')
  })

  test('a pass decision at HEAD clears the manual clause without any meta-audit', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ decisionVerdict: 'pass', decision: 'auto-pass', reasons: [] })
  })

  test('a fail decision blocks with a reason', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'fail', decider: 'alice', note: 'wrong' }, root, 1)
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ decisionVerdict: 'fail', decision: 'human' })
    expect(c001?.reasons).toContain('manual clause decided FAIL (P4: human adjudication)')
  })

  test('a decision lapses when HEAD moves', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'alice' }, root, 1)
    writeFileSync(join(root, 'other.txt'), 'x')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'move head')
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ decisionVerdict: 'none', decision: 'human' })
  })

  test('the latest decision at a head wins', () => {
    const root = setupRepo()
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 'a' }, root, 1)
    recordDecision(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'fail', decider: 'a' }, root, 2)
    const sha = currentHead(root)
    expect(sha).not.toBeNull()
    if (sha) expect(decisionsAtHead(db, sha).get('specs/x/spec.md#C001')).toBe('fail')
  })

  test('without a headSha the manual clause stays undecided (back-compat)', () => {
    setupRepo()
    const report = adjudicate(db)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ decisionVerdict: 'none', decision: 'human' })
  })
})
