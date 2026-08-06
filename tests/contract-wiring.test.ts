import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { loadContracts } from '../src/contract-parser.js'
import { adjudicate } from '../src/gate.js'
import { openRegistry } from '../src/registry.js'
import { scanWorkspace } from '../src/scanner.js'
import { buildStatus } from '../src/status.js'

let db: Database
const tempDirs: string[] = []

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-contract-wiring-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'specs/x'), { recursive: true })
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

describe('contract and decision wiring', () => {
  test('absent contract and decision artifacts retain legacy scan, status, and gate behavior', () => {
    const root = workspace()
    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 check <!-- oracle:cmd:true -->')

    const scan = scanWorkspace(db, root)
    const contracts = loadContracts(root)
    const status = buildStatus(db, { head: null, unmapped: [] })
    const gate = adjudicate(db)

    expect(scan.decisionErrors).toEqual([])
    expect(scan.decisionWarnings).toEqual([])
    expect(contracts).toEqual({ contracts: [], errors: [] })
    expect(status).toEqual({
      schema: 'urtext.status/1',
      head: null,
      items: [
        {
          key: 'specs/x/spec.md#C001',
          kind: 'clause',
          lane: 'agent',
          primary: 'missing_evidence',
          reasons: ['missing_evidence', 'unaudited'],
          next: 'run `urtext verify`',
          specPath: 'specs/x/spec.md',
          clauseId: 'C001',
          title: 'check',
          risk: 'low',
        },
      ],
      counts: { agent: 1, human: 0, uncovered: 0, autoPass: 0 },
      wip: { limit: 10, exceeded: false },
      uncoveredRequirements: [],
    })
    expect(gate).toMatchObject({
      unmappedCount: 0,
      interfaceSurfaceUnmappedCount: 0,
      overall: 'human',
      reasons: ['1 clause(s) require human adjudication'],
    })
  })

  test('a malformed contract is reported with its path and blocks auto-pass', () => {
    const root = workspace()
    writeFileSync(join(root, 'specs/x/contract.md'), '## I001 x')

    const contracts = loadContracts(root)
    const gate = adjudicate(db, 0, undefined, { contractErrorCount: contracts.errors.length })

    expect(contracts.errors).toEqual([
      expect.objectContaining({
        code: 'missing_surface',
        contractPath: 'specs/x/contract.md',
        interfaceId: 'I001',
      }),
    ])
    expect(gate.overall).toBe('human')
    expect(gate.reasons).toContain(
      '1 contract parse error(s) — fix `urtext check` failures before adjudicating'
    )
  })

  test('decision references resolve, fail for unknown ids, and warn for superseded decisions', () => {
    const root = workspace()
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/DECISIONS.md'), '## D1 t')
    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 check <!-- oracle:cmd:true dec:D1 -->')

    expect(scanWorkspace(db, root)).toMatchObject({ decisionErrors: [], decisionWarnings: [] })

    writeFileSync(join(root, 'specs/x/spec.md'), '## C001 check <!-- oracle:cmd:true dec:D2 -->')
    expect(scanWorkspace(db, root).decisionErrors).toEqual([
      expect.objectContaining({ code: 'unknown_dec', target: 'D2' }),
    ])

    writeFileSync(
      join(root, 'docs/DECISIONS.md'),
      ['## D1 t', '## D2 old <!-- superseded-by:D1 -->'].join('\n')
    )
    const scan = scanWorkspace(db, root)

    expect(scan.decisionErrors).toEqual([])
    expect(scan.decisionWarnings).toEqual([
      expect.objectContaining({ code: 'superseded_dec', target: 'D2', replacement: 'D1' }),
    ])
  })
})
