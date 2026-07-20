import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { importVerdicts, latestEvidence } from '../src/audit.js'
import { currentBriefHash } from '../src/brief.js'
import { recordDecision } from '../src/decision.js'
import { adjudicate } from '../src/gate.js'
import { openRegistry } from '../src/registry.js'
import { currentHead, recordReview } from '../src/review.js'
import { handleDecide } from '../src/review-ui.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const SPEC = [
  '## C001 money path <!-- oracle:cmd:true risk:high -->',
  'v1 semantics',
  '## C002 ship policy <!-- oracle:manual risk:high -->',
  '## C003 naming taste <!-- oracle:manual -->',
].join('\n')

const setupRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-brief-gate-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), SPEC)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  return root
}

const hashOf = (root: string, clauseId: string): string => {
  const hash = currentBriefHash(db, root, { specPath: 'specs/x/spec.md', clauseId })
  if (hash === null) throw new Error(`expected an approvable brief for ${clauseId}`)
  return hash
}

const approve = (root: string, briefHash?: string) =>
  recordReview(
    db,
    {
      specPath: 'specs/x/spec.md',
      clauseId: 'C001',
      decision: 'approve',
      reviewer: 'alice',
      ...(briefHash ? { briefHash } : {}),
    },
    root,
    1
  )

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('C018 review hardening (brief-hash + clean worktree, fail-closed)', () => {
  test('approving without a brief-hash fails closed', () => {
    const root = setupRepo()
    expect(approve(root)).toMatchObject({ kind: 'rejected', code: 'brief_required' })
  })

  test('approving with a non-current hash fails closed', () => {
    const root = setupRepo()
    expect(approve(root, 'deadbeef0000')).toMatchObject({ kind: 'rejected', code: 'brief_stale' })
  })

  test('approving with the current hash on a clean tree records', () => {
    const root = setupRepo()
    expect(approve(root, hashOf(root, 'C001')).kind).toBe('recorded')
  })

  test('a dirty worktree blocks approval even with a hash', () => {
    const root = setupRepo()
    const hash = hashOf(root, 'C001')
    writeFileSync(join(root, 'uncommitted.txt'), 'edit after brief')
    expect(approve(root, hash)).toMatchObject({ kind: 'rejected', code: 'dirty_worktree' })
  })

  test('content change after the brief invalidates the old hash', () => {
    const root = setupRepo()
    const stale = hashOf(root, 'C001')
    writeFileSync(join(root, 'specs/x/spec.md'), SPEC.replace('v1 semantics', 'v2 semantics'))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'change clause body') // tree clean again
    scanWorkspace(db, root)
    expect(approve(root, stale)).toMatchObject({ kind: 'rejected', code: 'brief_stale' })
    expect(approve(root, hashOf(root, 'C001')).kind).toBe('recorded')
  })

  test('rejecting needs no brief — a rejection is conservative', () => {
    const root = setupRepo()
    const outcome = recordReview(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', decision: 'reject', reviewer: 'alice' },
      root,
      1
    )
    expect(outcome.kind).toBe('recorded')
  })
})

describe('C018 decide hardening (high-risk manual only)', () => {
  const decide = (root: string, clauseId: string, verdict: 'pass' | 'fail', briefHash?: string) =>
    recordDecision(
      db,
      {
        specPath: 'specs/x/spec.md',
        clauseId,
        verdict,
        decider: 'alice',
        ...(briefHash ? { briefHash } : {}),
      },
      root,
      1
    )

  test('passing a high-risk manual clause requires the current brief', () => {
    const root = setupRepo()
    expect(decide(root, 'C002', 'pass')).toMatchObject({ kind: 'rejected', code: 'brief_required' })
    expect(decide(root, 'C002', 'pass', 'deadbeef0000')).toMatchObject({
      kind: 'rejected',
      code: 'brief_stale',
    })
    expect(decide(root, 'C002', 'pass', hashOf(root, 'C002')).kind).toBe('recorded')
  })

  test('failing a high-risk manual clause needs no brief (conservative)', () => {
    const root = setupRepo()
    expect(decide(root, 'C002', 'fail').kind).toBe('recorded')
  })

  test('a low-risk manual clause decides without a brief (unchanged M6 semantics)', () => {
    const root = setupRepo()
    expect(decide(root, 'C003', 'pass').kind).toBe('recorded')
  })

  test('the ui write path hits the same guard — no bypass', () => {
    const root = setupRepo()
    const result = handleDecide(
      db,
      root,
      { key: 'specs/x/spec.md#C002', verdict: 'pass', note: 'x' },
      'alice'
    )
    expect(result.status).toBe(400)
  })
})

describe('C018 gate consumption of dirty worktrees', () => {
  test('an approved high-risk clause re-queues while the tree is dirty', () => {
    const root = setupRepo()
    for (const evidence of latestEvidence(db)) {
      importVerdicts(db, [{ evidenceId: evidence.id, auditor: 'codex', verdict: 'agree' }], 1)
    }
    expect(approve(root, hashOf(root, 'C001')).kind).toBe('recorded')
    const head = currentHead(root) ?? undefined
    const clean = adjudicate(db, 0, head, { dirtyWorktree: false })
    expect(clean.decisions.find((d) => d.clauseId === 'C001')?.decision).toBe('auto-pass')
    const dirty = adjudicate(db, 0, head, { dirtyWorktree: true })
    const c001 = dirty.decisions.find((d) => d.clauseId === 'C001')
    expect(c001?.decision).toBe('human')
    expect(c001?.reasons).toContain('high-risk: worktree dirty since approval — commit or re-review (P5)')
  })
})
