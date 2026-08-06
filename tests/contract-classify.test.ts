import { describe, expect, test } from 'vitest'

import { classifyUnmapped, matchSurface } from '../src/contract-classify.js'
import type { FeatureContract } from '../src/contract-parser.js'

describe('matchSurface', () => {
  test('matches exact paths', () => {
    expect(matchSurface('src/cli.ts', 'src/cli.ts')).toBe(true)
  })

  test('matches star within exactly one path segment', () => {
    expect(matchSurface('src/*.ts', 'src/cli.ts')).toBe(true)
    expect(matchSurface('src/*.ts', 'src/ui/cli.ts')).toBe(false)
  })

  test('matches double-star across zero or more path segments', () => {
    expect(matchSurface('src/**/cli.ts', 'src/cli.ts')).toBe(true)
    expect(matchSurface('src/**/cli.ts', 'src/ui/cli.ts')).toBe(true)
  })

  test('does not match unrelated paths', () => {
    expect(matchSurface('src/*.ts', 'tests/cli.test.ts')).toBe(false)
  })
})

const contracts: FeatureContract[] = [
  {
    contractPath: 'specs/alpha/contract.md',
    entries: [
      { interfaceId: 'I002', title: 'CLI', surfaces: ['src/*.ts'], line: 0 },
      { interfaceId: 'I001', title: 'Registry', surfaces: ['src/registry.ts'], line: 1 },
    ],
  },
  {
    contractPath: 'specs/beta/contract.md',
    entries: [{ interfaceId: 'I001', title: 'Overlap', surfaces: ['src/**/*.ts'], line: 0 }],
  },
]

describe('classifyUnmapped', () => {
  test('returns sorted, deduplicated matching interface ids', () => {
    expect(classifyUnmapped([{ file: 'src/registry.ts', line: 1 }], contracts)).toEqual([
      { file: 'src/registry.ts', line: 1, matchedInterfaces: ['I001', 'I002'] },
    ])
  })

  test('matches a renamed hunk through its old path', () => {
    expect(
      classifyUnmapped([{ file: 'src/new.ts' }], contracts, { oldPathOf: () => 'src/registry.ts' })
    ).toEqual([{ file: 'src/new.ts', matchedInterfaces: ['I001', 'I002'] }])
  })

  test('returns empty matches when there are no contracts', () => {
    expect(classifyUnmapped([{ file: 'src/cli.ts' }], [])).toEqual([
      { file: 'src/cli.ts', matchedInterfaces: [] },
    ])
  })
})
