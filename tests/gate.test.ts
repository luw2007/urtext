import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { coverage, exportRequest, importVerdicts, latestEvidence } from '../src/audit.js'
import { adjudicate } from '../src/gate.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { verifyWorkspace } from '../src/verifier.js'

let db: Database
const tempDirs: string[] = []

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** Workspace with the given clause file, scanned and verified. */
const setupVerified = (specContent: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-m4-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'specs/x'), { recursive: true })
  writeFileSync(join(root, 'specs/x/spec.md'), specContent)
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  return root
}

const evidenceIdFor = (clauseId: string): number => {
  const row = latestEvidence(db).find((entry) => entry.clause_id === clauseId)
  if (!row) throw new Error(`no evidence for ${clauseId}`)
  return row.id
}

describe('exportRequest', () => {
  test('packages decided evidence with clause semantics; skips pending', () => {
    setupVerified(
      [
        '## C001 Always true <!-- oracle:cmd:true -->',
        'body of one',
        '## C002 Human check <!-- oracle:manual -->',
      ].join('\n')
    )
    const request = exportRequest(db)
    expect(request.protocol).toBe('urtext-meta-audit/v0')
    expect(request.items).toHaveLength(1)
    expect(request.items[0]).toMatchObject({
      clauseId: 'C001',
      verdict: 'pass',
      body: 'body of one',
      oracleKind: 'cmd',
    })
  })

  test('a stale (invalidated) evidence row is excluded — re-verify first', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    const id = evidenceIdFor('C001')
    db.prepare('UPDATE evidence SET invalidated_at = 1 WHERE id = ?').run(id)
    expect(exportRequest(db).items).toEqual([])
  })
})

describe('importVerdicts + coverage', () => {
  test('agree verdict bound to evidence raises coverage', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    const id = evidenceIdFor('C001')
    const outcome = importVerdicts(db, [{ evidenceId: id, auditor: 'codex', verdict: 'agree' }], 1)
    expect(outcome).toEqual({ kind: 'imported', count: 1 })

    const report = coverage(db)
    expect(report.coverage).toBe(1)
    expect(report.counts).toEqual({ agree: 1, disagree: 0, unaudited: 0 })
  })

  test('a verdict referencing an unknown evidence id is rejected (bound to real evidence)', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    const outcome = importVerdicts(db, [{ evidenceId: 9999, auditor: 'codex', verdict: 'agree' }], 1)
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'unknown_evidence' })
  })

  test('the latest verdict per evidence wins; disagree is counted', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    const id = evidenceIdFor('C001')
    importVerdicts(db, [{ evidenceId: id, auditor: 'a', verdict: 'agree' }], 1)
    importVerdicts(db, [{ evidenceId: id, auditor: 'a', verdict: 'disagree', note: 'oracle too weak' }], 2)
    const report = coverage(db)
    expect(report.counts).toEqual({ agree: 0, disagree: 1, unaudited: 0 })
  })
})

describe('adjudicate (risk-tier gate)', () => {
  const auditAgree = (clauseId: string) =>
    importVerdicts(db, [{ evidenceId: evidenceIdFor(clauseId), auditor: 'codex', verdict: 'agree' }], 1)

  test('low risk + pass + agree + not stale → auto-pass', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    auditAgree('C001')
    const report = adjudicate(db)
    expect(report.overall).toBe('auto-pass')
    expect(report.decisions[0]).toMatchObject({ decision: 'auto-pass', reasons: [] })
  })

  test('high risk always needs a human even when everything else is green', () => {
    setupVerified('## C001 Critical <!-- oracle:cmd:true risk:high -->')
    auditAgree('C001')
    const report = adjudicate(db)
    expect(report.overall).toBe('human')
    expect(report.decisions[0]?.reasons).toContain('high-risk (P5: code-level human review)')
  })

  test('unaudited evidence never auto-passes (D3: disagreement never silent)', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    const report = adjudicate(db)
    expect(report.decisions[0]).toMatchObject({ decision: 'human', auditVerdict: 'unaudited' })
    expect(report.decisions[0]?.reasons).toContain('no meta-audit verdict')
  })

  test('meta-audit disagreement forces a human', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    importVerdicts(db, [{ evidenceId: evidenceIdFor('C001'), auditor: 'codex', verdict: 'disagree' }], 1)
    const report = adjudicate(db)
    expect(report.decisions[0]?.reasons).toContain('meta-audit disagreement (D3)')
    expect(report.overall).toBe('human')
  })

  test('failing evidence forces a human', () => {
    setupVerified('## C001 Always false <!-- oracle:cmd:false -->')
    const report = adjudicate(db)
    expect(report.decisions[0]).toMatchObject({ evidenceVerdict: 'fail', decision: 'human' })
  })

  test('a stale clause forces a human even after an agree', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    auditAgree('C001')
    db.prepare('UPDATE evidence SET invalidated_at = 1 WHERE id = ?').run(evidenceIdFor('C001'))
    const report = adjudicate(db)
    expect(report.decisions[0]?.reasons).toContain('stale — upstream changed, re-verify required')
    expect(report.overall).toBe('human')
  })

  test('unmapped changes feed the overall verdict (P3 → P4)', () => {
    setupVerified('## C001 Always true <!-- oracle:cmd:true -->')
    auditAgree('C001')
    const clean = adjudicate(db, 0)
    expect(clean.overall).toBe('auto-pass')
    const dirty = adjudicate(db, 2)
    expect(dirty.overall).toBe('human')
    expect(dirty.reasons).toContain('2 unmapped change(s) (P3: write back to spec or ack)')
  })
})
