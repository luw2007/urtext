import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { importVerdicts, latestEvidence } from '../src/audit.js'
import { recordDecision } from '../src/decision.js'
import { openRegistry } from '../src/registry.js'
import { currentHead } from '../src/review.js'
import { scanWorkspace } from '../src/scanner.js'
import { buildStatus } from '../src/status.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

const git = (root: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

const makeRepo = (specLines: string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-status-'))
  tempDirs.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'test@urtext.dev')
  git(root, 'config', 'user.name', 'test')
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), specLines.join('\n'))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'baseline')
  return root
}

const agreeAll = () => {
  for (const evidence of latestEvidence(db)) {
    importVerdicts(db, [{ evidenceId: evidence.id, auditor: 'codex', verdict: 'agree' }], 1)
  }
}

const statusOf = (root: string) => buildStatus(db, { head: currentHead(root), unmapped: [] })

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('buildStatus lanes', () => {
  test('unverified clause lands in the agent lane; review need stays secondary', () => {
    const root = makeRepo(['## C001 pay guard <!-- oracle:cmd:true risk:high -->'])
    scanWorkspace(db, root)
    const report = statusOf(root)
    const item = report.items.find((entry) => entry.key === 'specs/x/spec.md#C001')
    expect(item).toMatchObject({ kind: 'clause', lane: 'agent', primary: 'missing_evidence' })
    expect(item?.reasons).toContain('review_needed')
    expect(report.counts.human).toBe(0)
  })

  test('a green low-risk clause auto-passes and produces no item', () => {
    const root = makeRepo(['## C001 label <!-- oracle:cmd:true -->'])
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    agreeAll()
    const report = statusOf(root)
    expect(report.items).toHaveLength(0)
    expect(report.counts).toEqual({ agent: 0, human: 0, autoPass: 1 })
  })

  test('a green high-risk clause without review is the human queue', () => {
    const root = makeRepo(['## C001 pay <!-- oracle:cmd:true risk:high -->'])
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    agreeAll()
    const report = statusOf(root)
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ lane: 'human', primary: 'review_needed', risk: 'high' })
  })

  test('manual clause: undecided is human; a pass decision at HEAD clears it', () => {
    const root = makeRepo(['## C001 policy <!-- oracle:manual -->'])
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    expect(statusOf(root).items[0]).toMatchObject({ lane: 'human', primary: 'manual_undecided' })
    recordDecision(
      db,
      { specPath: 'specs/x/spec.md', clauseId: 'C001', verdict: 'pass', decider: 't' },
      root,
      1
    )
    expect(statusOf(root).items).toHaveLength(0)
  })

  test('an upstream text change routes the dependent to the agent lane as stale', () => {
    const spec = (body: string) => [
      '## C001 base <!-- oracle:cmd:true -->',
      body,
      '## C002 dep <!-- oracle:cmd:true refs:specs/x/spec.md#C001 -->',
    ]
    const root = makeRepo(spec('v1 body'))
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    agreeAll()
    writeFileSync(join(root, 'specs/x/spec.md'), spec('v2 body changed').join('\n'))
    scanWorkspace(db, root)
    const dep = statusOf(root).items.find((entry) => entry.key === 'specs/x/spec.md#C002')
    expect(dep).toMatchObject({ lane: 'agent' })
    expect(dep?.reasons).toContain('stale')
  })
})

describe('buildStatus unmapped + wip', () => {
  test('unmapped hunks head the human queue as their own items', () => {
    const root = makeRepo(['## C001 label <!-- oracle:cmd:true -->'])
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    agreeAll()
    const report = buildStatus(db, {
      head: currentHead(root),
      unmapped: [{ filePath: 'src/a.ts', lineStart: 3, lineEnd: 9 }],
    })
    expect(report.items[0]).toMatchObject({
      key: 'src/a.ts:3-9',
      kind: 'unmapped',
      lane: 'human',
      primary: 'unmapped',
    })
    expect(report.counts.human).toBe(1)
  })

  test('a clause appears once — item-keyed, not reason-keyed', () => {
    const root = makeRepo(['## C001 pay <!-- oracle:cmd:true risk:high -->'])
    scanWorkspace(db, root)
    const report = statusOf(root)
    const keys = report.items.map((entry) => entry.key)
    expect(keys.filter((key) => key === 'specs/x/spec.md#C001')).toHaveLength(1)
    expect(report.items[0]!.reasons.length).toBeGreaterThan(1)
  })

  test('the wip limit flags an oversized human queue', () => {
    const root = makeRepo(['## C001 label <!-- oracle:cmd:true -->'])
    scanWorkspace(db, root)
    verifyWorkspace(db, root)
    agreeAll()
    const report = buildStatus(db, {
      head: currentHead(root),
      unmapped: [
        { filePath: 'src/a.ts', lineStart: 1, lineEnd: 2 },
        { filePath: 'src/b.ts', lineStart: 1, lineEnd: 2 },
      ],
      wipLimit: 1,
    })
    expect(report.wip).toEqual({ limit: 1, exceeded: true })
  })
})
