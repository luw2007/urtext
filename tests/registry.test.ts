import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { indexClauseFile, indexTaskFile, openRegistry, tombstoneFile } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'

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

const VALID_CLAUSES = ['## C001 不可叠加 <!-- oracle:manual req:FR001 -->', 'body'].join('\n')

describe('registry revision chain', () => {
  test('requirements, deduplicated req JSON, and normalized req edges share the revision', () => {
    const outcome = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: [
        '## FR001 意图',
        'why',
        '## C001 锁 <!-- oracle:manual req:FR001,FR001,specs/y/spec.md#FR002, -->',
      ].join('\n'),
      timestamp: 1,
    })
    expect(outcome).toMatchObject({ kind: 'indexed', status: 'ready' })
    expect(db.prepare('SELECT req_id, title FROM requirements').all()).toEqual([
      { req_id: 'FR001', title: '意图' },
    ])
    expect(db.prepare('SELECT reqs FROM clauses').get()).toEqual({
      reqs: JSON.stringify([
        { path: null, reqId: 'FR001' },
        { path: 'specs/y/spec.md', reqId: 'FR002' },
      ]),
    })
    expect(
      db.prepare('SELECT clause_id, to_spec, to_req FROM clause_reqs ORDER BY to_spec, to_req').all()
    ).toEqual([
      { clause_id: 'C001', to_spec: '', to_req: 'FR001' },
      { clause_id: 'C001', to_spec: 'specs/y/spec.md', to_req: 'FR002' },
    ])
  })

  test('persists decision edges with the indexed clause revision', () => {
    indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## FR001 intent\n## C001 lock <!-- oracle:manual req:FR001 dec:D10,D1 -->',
      timestamp: 1,
    })

    expect(
      db.prepare('SELECT clause_id, dec_id, line FROM clause_decs ORDER BY dec_id').all()
    ).toEqual([
      { clause_id: 'C001', dec_id: 'D1', line: 1 },
      { clause_id: 'C001', dec_id: 'D10', line: 1 },
    ])
  })

  test('FR text edits and removals are changedRequirements without clause text churn', () => {
    const content = (body: string) =>
      ['## FR001 意图', body, '## C001 锁 <!-- oracle:manual req:FR001 -->'].join('\n')
    indexClauseFile(db, { specPath: 'specs/x/spec.md', content: content('v1'), timestamp: 1 })
    const changed = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: content('v2'),
      timestamp: 2,
    })
    expect(changed.kind === 'indexed' && changed.changedRequirements).toEqual(['FR001'])
    expect(changed.kind === 'indexed' && changed.changedClauses).toEqual([])

    const removed = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## C001 锁 <!-- oracle:manual req:FR001 -->',
      timestamp: 3,
    })
    expect(removed.kind === 'indexed' && removed.changedRequirements).toEqual(['FR001'])
  })

  test('a grammar-v0 ready row is preserved and byte-identical content reparses at v1', () => {
    const legacy = new DatabaseConstructor(':memory:')
    const content = '## C001 old <!-- oracle:manual -->'
    const contentHash = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
    legacy.exec(`
      CREATE TABLE revisions (
        spec_path TEXT NOT NULL, revision INTEGER NOT NULL, file_kind TEXT NOT NULL,
        content_hash TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (spec_path, revision)
      );
      CREATE TABLE clauses (
        spec_path TEXT NOT NULL, revision INTEGER NOT NULL, clause_id TEXT NOT NULL,
        seq INTEGER NOT NULL, title TEXT NOT NULL, text_hash TEXT NOT NULL DEFAULT '',
        oracle_kind TEXT, oracle_ref TEXT, risk TEXT NOT NULL DEFAULT 'low',
        refs TEXT NOT NULL DEFAULT '[]', body TEXT, line INTEGER NOT NULL,
        PRIMARY KEY (spec_path, revision, clause_id)
      );
    `)
    legacy.prepare(
      `INSERT INTO revisions VALUES ('specs/x/spec.md', 1, 'clauses', ?, 'ready', 1)`
    ).run(contentHash)
    legacy.prepare(
      `INSERT INTO clauses VALUES ('specs/x/spec.md', 1, 'C001', 1, 'old', '', 'manual', NULL, 'low', '[]', NULL, 0)`
    ).run()

    openRegistry(legacy)
    const outcome = indexClauseFile(legacy, {
      specPath: 'specs/x/spec.md',
      content,
      timestamp: 2,
    })
    expect(outcome).toMatchObject({ kind: 'indexed', revision: 2, status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'missing_requirement' }),
    ])
    expect(
      legacy.prepare('SELECT revision, status, grammar_version FROM revisions ORDER BY revision').all()
    ).toEqual([
      { revision: 1, status: 'ready', grammar_version: 0 },
      { revision: 2, status: 'building', grammar_version: 2 },
    ])
    legacy.close()
  })

  test('same content is a no-op; new content appends an immutable revision', () => {
    const first = indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 1 })
    expect(first).toMatchObject({ kind: 'indexed', revision: 1, status: 'ready' })

    const unchanged = indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 2 })
    expect(unchanged).toEqual({ kind: 'unchanged', revision: 1, status: 'ready' })

    const second = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: `${VALID_CLAUSES}\nmore`,
      timestamp: 3,
    })
    expect(second).toMatchObject({ kind: 'indexed', revision: 2, status: 'ready' })

    // Revision 1 rows are untouched (immutable chain).
    const rows = db
      .prepare('SELECT revision, status FROM revisions WHERE spec_path = ? ORDER BY revision')
      .all('specs/x/spec.md')
    expect(rows).toEqual([
      { revision: 1, status: 'ready' },
      { revision: 2, status: 'ready' },
    ])
  })

  test('a clause without an oracle keeps the revision at building (never activatable)', () => {
    const outcome = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## C001 无门禁子句 <!-- req:FR001 -->',
      timestamp: 1,
    })
    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'missing_oracle' }),
    ])
  })

  test('a missing requirement keeps the clause revision building', () => {
    const outcome = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: '## C001 intent lock <!-- oracle:manual -->',
      timestamp: 1,
    })

    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'missing_requirement', clauseId: 'C001' }),
    ])
  })

  test('FR oracle and risk anchors keep the revision building with exact requirement errors', () => {
    const outcome = indexClauseFile(db, {
      specPath: 'specs/x/spec.md',
      content: [
        '## FR001 intent <!-- oracle:cmd:true risk:high -->',
        '## C001 intent lock <!-- oracle:manual req:FR001 -->',
      ].join('\n'),
      timestamp: 1,
    })

    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'oracle_on_requirement', reqId: 'FR001' }),
      expect.objectContaining({ code: 'risk_on_requirement', reqId: 'FR001' }),
    ])
  })

  test('a task citing an undeclared clause is unknown_clause (fail-closed)', () => {
    const outcome = indexTaskFile(db, {
      specPath: 'specs/x/tasks.md',
      content: '- [ ] T001 Task <!-- clauses:C999 -->',
      timestamp: 1,
      unitClauseIds: new Set(['C001']),
    })
    expect(outcome).toMatchObject({ kind: 'indexed', status: 'building' })
    expect(outcome.kind === 'indexed' && outcome.errors).toEqual([
      expect.objectContaining({ code: 'unknown_clause', fileId: 'T001' }),
    ])
  })

  test('deletion tombstones a NEW revision without touching history', () => {
    indexClauseFile(db, { specPath: 'specs/x/spec.md', content: VALID_CLAUSES, timestamp: 1 })
    const tombstoned = tombstoneFile(db, {
      specPath: 'specs/x/spec.md',
      fileKind: 'clauses',
      timestamp: 2,
    })
    expect(tombstoned).toMatchObject({ kind: 'tombstoned', revision: 2 })

    // Idempotent; a never-indexed path is a no-op.
    expect(
      tombstoneFile(db, { specPath: 'specs/x/spec.md', fileKind: 'clauses', timestamp: 3 })
    ).toEqual({ kind: 'unchanged', revision: 2, status: 'tombstoned' })
    expect(tombstoneFile(db, { specPath: 'specs/y/spec.md', fileKind: 'clauses', timestamp: 3 })).toBeNull()

    const clauseRows = db
      .prepare('SELECT clause_id FROM clauses WHERE spec_path = ? AND revision = 1')
      .all('specs/x/spec.md')
    expect(clauseRows).toHaveLength(1)
  })
})

describe('scanWorkspace', () => {
  test('revision reconciliation rolls back when stale invalidation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    const spec = (body: string) =>
      ['## FR001 intent', body, '## C001 lock <!-- oracle:manual req:FR001 -->'].join('\n')
    writeFileSync(join(root, 'specs/x/spec.md'), spec('v1'))
    scanWorkspace(db, root)
    db.prepare(
      `INSERT INTO evidence
         (spec_path, revision, clause_id, oracle_kind, verdict, output, created_at)
       VALUES ('specs/x/spec.md', 1, 'C001', 'manual', 'pass', '', 1)`
    ).run()
    db.exec(`
      CREATE TRIGGER fail_stale BEFORE UPDATE OF invalidated_at ON evidence
      BEGIN SELECT RAISE(ABORT, 'forced stale failure'); END;
    `)

    writeFileSync(join(root, 'specs/x/spec.md'), spec('v2'))
    expect(() => scanWorkspace(db, root)).toThrow('forced stale failure')
    expect(
      db.prepare(`SELECT MAX(revision) AS revision FROM revisions WHERE spec_path = 'specs/x/spec.md'`).get()
    ).toEqual({ revision: 1 })
    expect(db.prepare('SELECT invalidated_at FROM evidence').get()).toEqual({ invalidated_at: null })
  })

  test('indexes clause files before the checklist so unit refs resolve', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(
      join(root, 'specs/coupon/spec.md'),
      ['## FR001 intent', '## C001 不可叠加 <!-- oracle:test:tests/stack.test.ts req:FR001 -->', 'Given/When/Then'].join('\n')
    )
    writeFileSync(
      join(root, 'specs/coupon/tasks.md'),
      '- [ ] T001 实现校验 <!-- role:coder gate:true clauses:C001 -->'
    )

    const report = scanWorkspace(db, root)
    expect(report.units).toEqual([
      {
        feature: 'coupon',
        clauseFiles: ['specs/coupon/spec.md'],
        taskFile: 'specs/coupon/tasks.md',
      },
    ])
    expect(report.outcomes.map(({ specPath, outcome }) => [specPath, outcome.kind])).toEqual([
      ['specs/coupon/spec.md', 'indexed'],

      ['specs/coupon/tasks.md', 'indexed'],
    ])
    for (const { outcome } of report.outcomes) {
      expect(outcome).toMatchObject({ status: 'ready' })
    }
  })

  test('reports decision links independently from ordinary workspace links', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/x'), { recursive: true })
    writeFileSync(
      join(root, 'specs/x/spec.md'),
      '## FR001 intent\n## C001 lock <!-- oracle:manual req:FR001 dec:D1 -->'
    )

    const report = scanWorkspace(db, root)
    expect(report.linkErrors).toEqual([])
    expect(report.decisionErrors).toEqual([
      expect.objectContaining({ code: 'missing_decisions_doc', clauseId: 'C001' }),
    ])
    expect(report.decisionWarnings).toEqual([])
  })

  test('a checklist citing a clause missing from the unit stays building', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/coupon'), { recursive: true })
    writeFileSync(
      join(root, 'specs/coupon/tasks.md'),
      '- [ ] T001 实现校验 <!-- clauses:C001 -->'
    )

    const report = scanWorkspace(db, root)
    const tasksOutcome = report.outcomes.find(({ specPath }) => specPath.endsWith('tasks.md'))
    expect(tasksOutcome?.outcome).toMatchObject({ kind: 'indexed', status: 'building' })
  })

  test('a workspace without specs/ yields no units', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    expect(scanWorkspace(db, root)).toEqual({
      units: [],
      outcomes: [],
      linkErrors: [],
      decisionErrors: [],
      decisionWarnings: [],
      stale: { staleClauses: [], invalidatedEvidence: 0 },
      clauselessUnits: [],
    })
  })

  test('a feature whose clause files declare zero clauses is flagged clauseless, not failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/prose'), { recursive: true })
    // Spec-Kit-style prose: headings, requirements, no `## C<n> <!-- oracle -->`.
    writeFileSync(join(root, 'specs/prose/spec.md'), '# Feature\n\n## Requirements\n\n- FR-001 The system MUST do X.\n')
    const report = scanWorkspace(db, root)
    expect(report.clauselessUnits).toEqual(['prose'])
    // Clauseless is a visible hint, not a validation failure — the file is ready.
    expect(report.outcomes[0]?.outcome).toMatchObject({ status: 'ready' })
  })

  test('a feature with a building clause file is not flagged clauseless (its errors are the problem)', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-scan-'))
    tempDirs.push(root)
    mkdirSync(join(root, 'specs/broken'), { recursive: true })
    writeFileSync(join(root, 'specs/broken/spec.md'), '## C001 no oracle bound\nbody\n')
    const report = scanWorkspace(db, root)
    expect(report.clauselessUnits).toEqual([])
  })
})
