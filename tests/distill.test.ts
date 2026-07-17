import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { coverage, discover, distillUsage, validate } from '../src/distill.js'

const tempDirs: string[] = []

const makeWorkspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'urtext-distill-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'cmd/server'), { recursive: true })
  mkdirSync(join(root, 'internal/payments'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'specs/payments'), { recursive: true })
  writeFileSync(join(root, 'src/cli.ts'), 'export const run = () => undefined\n')
  writeFileSync(join(root, 'src/charge.ts'), 'export const charge = () => undefined\n')
  writeFileSync(join(root, 'tests/charge.test.ts'), 'export const testCharge = () => undefined\n')
  writeFileSync(join(root, 'cmd/server/main.go'), 'package main\n')
  writeFileSync(join(root, 'internal/payments/charge.go'), 'package payments\n')
  writeFileSync(join(root, 'internal/payments/charge_test.go'), 'package payments\n')
  writeFileSync(
    join(root, 'specs/payments/spec.md'),
    [
      '# Payments',
      '',
      '## C001 Charges succeed <!-- oracle:test:tests/charge.test.ts -->',
      '',
      'A valid charge completes.',
      '',
      '## Implementation Evidence',
      '',
      '- `src/charge.ts`',
      '- `tests/charge.test.ts`',
    ].join('\n')
  )
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture'], { cwd: root })
  return root
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

test('documents every distill subcommand and its output boundary', () => {
  expect(distillUsage()).toContain('urtext distill discover')
  expect(distillUsage()).toContain('urtext distill coverage')
  expect(distillUsage()).toContain('urtext distill validate')
  expect(distillUsage()).toContain('without modifying canonical specs')
})

describe('codebase fact distillation', () => {
  test('discovers sorted observed facts separately from declared feature evidence', () => {
    const root = makeWorkspace()

    const manifest = discover(root)

    expect(manifest.schema).toBe('urtext-distill-facts/v1')
    expect(manifest.workspaceHead).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.observed.sourceFiles).toEqual([
      'cmd/server/main.go',
      'internal/payments/charge.go',
      'src/charge.ts',
      'src/cli.ts',
    ])
    expect(manifest.observed.testFiles).toEqual(['internal/payments/charge_test.go', 'tests/charge.test.ts'])
    expect(manifest.observed.entrypoints).toEqual(['cmd/server/main.go', 'src/cli.ts'])
    expect(manifest.declared.features).toEqual([
      {
        implementationEvidence: ['src/charge.ts', 'tests/charge.test.ts'],
        path: 'specs/payments/spec.md',
        testOracleTargets: ['tests/charge.test.ts'],
      },
    ])

    const saved = JSON.parse(readFileSync(join(root, '.urtext/distill/facts.json'), 'utf8')) as unknown
    expect(saved).toEqual(manifest)
  })

  test('reports missing declared evidence and observed files without a declaration', () => {
    const root = makeWorkspace()
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      [
        '# Payments',
        '',
        '## Implementation Evidence',
        '',
        '- `src/charge.ts`',
        '- `src/missing.ts`',
      ].join('\n')
    )

    const report = coverage(discover(root), root)

    expect(report.missingEvidence).toEqual([{ feature: 'specs/payments/spec.md', path: 'src/missing.ts' }])
    expect(report.unownedObservedFiles).toEqual([
      'cmd/server/main.go',
      'internal/payments/charge.go',
      'internal/payments/charge_test.go',
      'src/cli.ts',
      'tests/charge.test.ts',
    ])
  })

  test('accepts directories and globs as declared evidence and assigns their observed files', () => {
    const root = makeWorkspace()
    mkdirSync(join(root, 'contracts'), { recursive: true })
    writeFileSync(join(root, 'contracts/payments.yaml'), 'openapi: 3.0.0\n')
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      [
        '# Payments',
        '',
        '## Implementation Evidence',
        '',
        '- `internal/payments/`',
        '- `contracts/*.yaml`',
      ].join('\n')
    )

    const facts = discover(root)

    expect(coverage(facts, root).unownedObservedFiles).not.toContain('internal/payments/charge.go')
    expect(coverage(facts, root).unownedObservedFiles).not.toContain('internal/payments/charge_test.go')
  })

  test('rejects missing implementation evidence and missing test oracle targets', () => {
    const root = makeWorkspace()
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      [
        '# Payments',
        '',
        '## C001 Charges succeed <!-- oracle:test:tests/missing.test.ts -->',
        '',
        '## Implementation Evidence',
        '',
        '- `src/missing.ts`',
      ].join('\n')
    )

    expect(validate(discover(root), root).errors).toEqual([
      {
        feature: 'specs/payments/spec.md',
        kind: 'missing_evidence',
        path: 'src/missing.ts',
      },
      {
        feature: 'specs/payments/spec.md',
        kind: 'missing_oracle_target',
        path: 'tests/missing.test.ts',
      },
    ])
  })

  test('validates test oracle targets even without implementation evidence', () => {
    const root = makeWorkspace()
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      '## C001 Charges succeed <!-- oracle:test:tests/missing.test.ts -->\n'
    )

    expect(validate(discover(root), root).errors).toEqual([
      {
        feature: 'specs/payments/spec.md',
        kind: 'missing_oracle_target',
        path: 'tests/missing.test.ts',
      },
    ])
  })
})
