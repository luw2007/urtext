import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { parseDecisionsDoc } from '../src/decisions-doc.js'
import { linkDecisions } from '../src/linker.js'
import { indexClauseFile, openRegistry } from '../src/registry.js'

let db: Database

beforeEach(() => {
  db = new DatabaseConstructor(':memory:')
  openRegistry(db)
})

afterEach(() => {
  db.close()
})

const index = (content: string) =>
  indexClauseFile(db, { specPath: 'specs/x/spec.md', content, timestamp: 1 })

const clause = (dec: string) =>
  `## FR001 intent\n## C001 decision-bound <!-- oracle:manual req:FR001 dec:${dec} -->`

describe('linkDecisions', () => {
  test('is compatible with absent and malformed decision documents when there are no decision edges', () => {
    index('## FR001 intent\n## C001 ordinary <!-- oracle:manual req:FR001 -->')

    expect(linkDecisions(db, null)).toEqual({ errors: [], warnings: [] })
    expect(linkDecisions(db, parseDecisionsDoc('## D01 malformed'))).toEqual({ errors: [], warnings: [] })
  })

  test('reports a missing decisions document for every referencing edge', () => {
    index(clause('D1'))

    expect(linkDecisions(db, null)).toEqual({
      errors: [
        expect.objectContaining({
          code: 'missing_decisions_doc',
          specPath: 'specs/x/spec.md',
          clauseId: 'C001',
          target: 'D1',
        }),
      ],
      warnings: [],
    })
  })

  test('reports unknown decision ids', () => {
    index(clause('D9'))

    expect(linkDecisions(db, parseDecisionsDoc('## D1 Known'))).toEqual({
      errors: [expect.objectContaining({ code: 'unknown_dec', target: 'D9' })],
      warnings: [],
    })
  })

  test('warns when a referenced decision is directly superseded', () => {
    index(clause('D1'))

    expect(
      linkDecisions(
        db,
        parseDecisionsDoc(['## D1 Original <!-- superseded-by:D2 -->', '## D2 Replacement'].join('\n'))
      )
    ).toEqual({
      errors: [],
      warnings: [
        expect.objectContaining({
          code: 'superseded_dec',
          specPath: 'specs/x/spec.md',
          clauseId: 'C001',
          target: 'D1',
          replacement: 'D2',
        }),
      ],
    })
  })

  test('surfaces malformed decision documents and still checks parsed entries', () => {
    index(clause('D9'))

    expect(linkDecisions(db, parseDecisionsDoc('## D01 malformed'))).toEqual({
      errors: [
        expect.objectContaining({
          code: 'decisions_doc_error',
          specPath: 'docs/DECISIONS.md',
          clauseId: '',
        }),
        expect.objectContaining({ code: 'unknown_dec', target: 'D9' }),
      ],
      warnings: [],
    })
  })
})
