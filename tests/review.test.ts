import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { adjudicate } from '../src/gate.js'
import { openRegistry } from '../src/registry.js'
import { currentHead, recordReview, reviewsAtHead } from '../src/review.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'
import { importVerdicts, latestEvidence } from '../src/audit.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A git repo with a high-risk C001 (cmd:true) + low-risk C002, verified. */
const setupRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-review-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(
    join(root, 'specs/x/spec.md'),
    [
      '## C001 money path <!-- oracle:cmd:true risk:high -->',
      '## C002 label <!-- oracle:cmd:true -->',
    ].join('\n')
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  return root
}

const agreeAll = () => {
  for (const evidence of latestEvidence(db)) {
    importVerdicts(db, [{ evidenceId: evidence.id, auditor: 'codex', verdict: 'agree' }], 1)
  }
}

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('recordReview', () => {
  test('records an approval bound to HEAD for a high-risk clause', () => {
    const root = setupRepo()
    const outcome = recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'approve', reviewer: 'alice' },
      root,
      1
    )
    expect(outcome.kind).toBe('recorded')
    if (outcome.kind === 'recorded') {
      expect(outcome.commitSha).toBe(currentHead(root))
    }
  })

  test('rejects reviewing a low-risk clause (unsafe lane is high-risk only)', () => {
    const root = setupRepo()
    const outcome = recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C002', decision: 'approve', reviewer: 'alice' },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'not_high_risk' })
  })

  test('rejects reviewing an unknown clause', () => {
    const root = setupRepo()
    const outcome = recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C999', decision: 'approve', reviewer: 'alice' },
      root,
      1
    )
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'unknown_clause' })
  })
})

describe('gate unsafe lane', () => {
  test('a high-risk clause with everything green but no review stays human', () => {
    const root = setupRepo()
    agreeAll()
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ reviewStatus: 'none', decision: 'human' })
    expect(c001?.reasons).toContain('high-risk: needs human code review — `urtext review` (P5)')
  })

  test('an approved high-risk clause auto-passes when evidence + audit are green', () => {
    const root = setupRepo()
    agreeAll()
    recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'approve', reviewer: 'alice' },
      root,
      1
    )
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ reviewStatus: 'approved', decision: 'auto-pass', reasons: [] })
    expect(report.overall).toBe('auto-pass')
  })

  test('a rejected review keeps the clause human', () => {
    const root = setupRepo()
    agreeAll()
    recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'reject', reviewer: 'alice', note: 'unsafe' },
      root,
      1
    )
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ reviewStatus: 'rejected', decision: 'human' })
    expect(c001?.reasons).toContain('high-risk: human code review REJECTED (P5)')
  })

  test('an approval lapses when HEAD moves — the code changed, re-review required', () => {
    const root = setupRepo()
    agreeAll()
    recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'approve', reviewer: 'alice' },
      root,
      1
    )
    // New commit moves HEAD; the approval was bound to the old sha.
    writeFileSync(join(root, 'other.txt'), 'x')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'move head')
    const report = adjudicate(db, 0, currentHead(root) ?? undefined)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ reviewStatus: 'none', decision: 'human' })
  })

  test('the latest review at a head wins (reject after approve)', () => {
    const root = setupRepo()
    const key = 'specs/x/spec.md#C001'
    recordReview(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'approve', reviewer: 'a' }, root, 1)
    recordReview(db, { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'reject', reviewer: 'a' }, root, 2)
    const sha = currentHead(root)
    expect(sha).not.toBeNull()
    if (sha) expect(reviewsAtHead(db, sha).get(key)).toBe('reject')
  })

  test('without a headSha the lane is inert — high-risk stays human (back-compat)', () => {
    setupRepo()
    agreeAll()
    const report = adjudicate(db)
    const c001 = report.decisions.find((d) => d.clauseId === 'C001')
    expect(c001).toMatchObject({ reviewStatus: 'none', decision: 'human' })
  })
})
