import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { loadDecisionsDoc, parseDecisionsDoc } from '../src/decisions-doc.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('parseDecisionsDoc', () => {
  test('extracts canonical D-ids exactly, including D1 and D10', () => {
    const parsed = parseDecisionsDoc(
      [
        '# Introduction',
        '### D1 First decision',
        '## D10 Tenth decision <!-- superseded-by:D1 -->',
      ].join('\n')
    )

    expect(parsed.errors).toEqual([])
    expect(parsed.entries).toEqual([
      { decId: 'D1', title: 'First decision', supersededBy: null, line: 1 },
      { decId: 'D10', title: 'Tenth decision', supersededBy: 'D1', line: 2 },
    ])
  })

  test('rejects non-canonical decision headings instead of treating them as prose', () => {
    const parsed = parseDecisionsDoc(
      ['## D01 Leading zero', '### d1 Lowercase', '### d01 Lowercase zero'].join('\n')
    )

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'invalid_dec_id', decId: 'D01', line: 0 }),
      expect.objectContaining({ code: 'invalid_dec_id', decId: 'd1', line: 1 }),
      expect.objectContaining({ code: 'invalid_dec_id', decId: 'd01', line: 2 }),
    ])
  })

  test('reports duplicate decision ids', () => {
    const parsed = parseDecisionsDoc(['## D1 First', '## D1 Duplicate'].join('\n'))

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'duplicate_dec_id', decId: 'D1', line: 1 }),
    ])
  })

  test('reports supersede targets that are not declared', () => {
    const parsed = parseDecisionsDoc('## D1 First <!-- superseded-by:D2 -->')

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'unknown_supersede_target', decId: 'D1', line: 0 }),
    ])
  })

  test('rejects an empty supersede target', () => {
    const parsed = parseDecisionsDoc('## D1 First <!-- superseded-by: -->')

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'unknown_supersede_target', decId: 'D1', line: 0 }),
    ])
  })

  test('reports self-referential and multi-decision supersede cycles', () => {
    const self = parseDecisionsDoc('## D1 First <!-- superseded-by:D1 -->')
    const cycle = parseDecisionsDoc(
      ['## D1 First <!-- superseded-by:D2 -->', '## D2 Second <!-- superseded-by:D1 -->'].join('\n')
    )

    expect(self.errors).toEqual([
      expect.objectContaining({ code: 'supersede_cycle', decId: 'D1', line: 0 }),
    ])
    expect(cycle.errors).toEqual([
      expect.objectContaining({ code: 'supersede_cycle', decId: 'D1' }),
      expect.objectContaining({ code: 'supersede_cycle', decId: 'D2' }),
    ])
  })

  test('allows an acyclic supersede chain', () => {
    const parsed = parseDecisionsDoc(
      [
        '## D1 Original <!-- superseded-by:D2 -->',
        '## D2 Revision <!-- superseded-by:D3 -->',
        '## D3 Current',
      ].join('\n')
    )

    expect(parsed.errors).toEqual([])
  })

  test('surfaces malformed heading anchors', () => {
    const parsed = parseDecisionsDoc('## D1 First <!-- malformed -->')

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'malformed_anchor', decId: 'D1', line: 0 }),
    ])
  })
})

describe('loadDecisionsDoc', () => {
  test('returns null only when docs/DECISIONS.md is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'urtext-decisions-'))
    tempDirs.push(root)

    expect(loadDecisionsDoc(root)).toBeNull()

    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs/DECISIONS.md'), '## D1 Present')
    expect(loadDecisionsDoc(root)?.entries).toEqual([
      { decId: 'D1', title: 'Present', supersededBy: null, line: 0 },
    ])
  })
})
