import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { loadContracts, parseContractFile } from '../src/contract-parser.js'

const tempDirs: string[] = []

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-contract-'))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('parseContractFile', () => {
  test('parses comma-separated surface paths from interface headings', () => {
    const parsed = parseContractFile(
      '## I001 Registry schema <!-- surface:src/registry.ts,src/dwarf.ts -->\n\nBody prose is ignored.'
    )

    expect(parsed).toEqual({
      entries: [{ interfaceId: 'I001', title: 'Registry schema', surfaces: ['src/registry.ts', 'src/dwarf.ts'], line: 0 }],
      errors: [],
    })
  })

  test('rejects missing or all-empty surface fields', () => {
    const parsed = parseContractFile(
      ['## I001 No field', '## I002 Empty <!-- surface:,, -->'].join('\n')
    )

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'missing_surface', interfaceId: 'I001', line: 0 }),
      expect.objectContaining({ code: 'missing_surface', interfaceId: 'I002', line: 1 }),
    ])
  })

  test('rejects duplicate interface ids', () => {
    const parsed = parseContractFile(
      ['## I001 First <!-- surface:src/a.ts -->', '## I001 Second <!-- surface:src/b.ts -->'].join('\n')
    )

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'duplicate_interface_id', interfaceId: 'I001', line: 1 }),
    ])
  })

  test('rejects absolute and parent-traversal surfaces while retaining valid paths', () => {
    const parsed = parseContractFile(
      '## I001 Paths <!-- surface:/etc/passwd,src/../secret.ts,src/ok.ts -->'
    )

    expect(parsed.entries[0]?.surfaces).toEqual(['src/ok.ts'])
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'invalid_surface_path', interfaceId: 'I001', line: 0 }),
      expect.objectContaining({ code: 'invalid_surface_path', interfaceId: 'I001', line: 0 }),
    ])
  })

  test('surfaces malformed anchor fields with the interface id', () => {
    const parsed = parseContractFile('## I001 Broken <!-- surface:src/a.ts junk -->')

    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'malformed_anchor', interfaceId: 'I001', line: 0 }),
    ])
  })
})

describe('loadContracts', () => {
  test('aggregates contracts from multiple features and preserves legal overlaps', () => {
    const root = workspace()
    mkdirSync(join(root, 'specs', 'alpha'), { recursive: true })
    mkdirSync(join(root, 'specs', 'beta'), { recursive: true })
    writeFileSync(join(root, 'specs', 'alpha', 'contract.md'), '## I001 Alpha <!-- surface:src/shared.ts -->')
    writeFileSync(join(root, 'specs', 'beta', 'contract.md'), '## I002 Beta <!-- surface:src/shared.ts -->')

    expect(loadContracts(root)).toEqual({
      contracts: [
        {
          contractPath: 'specs/alpha/contract.md',
          entries: [{ interfaceId: 'I001', title: 'Alpha', surfaces: ['src/shared.ts'], line: 0 }],
        },
        {
          contractPath: 'specs/beta/contract.md',
          entries: [{ interfaceId: 'I002', title: 'Beta', surfaces: ['src/shared.ts'], line: 0 }],
        },
      ],
      errors: [],
    })
  })

  test('returns an empty result when contracts are absent', () => {
    expect(loadContracts(workspace())).toEqual({ contracts: [], errors: [] })
  })
})
