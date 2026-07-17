import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { coverage, discover, distillUsage, promote, validate } from '../src/distill.js'

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
  expect(distillUsage()).toContain('urtext distill promote')
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

  test('promotes only observed low-risk runnable draft clauses after feature confirmation', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    const draft = join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md')
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      draft,
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Eligible <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: observed',
        '',
        '## C007 Inferred <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: inferred',
        '',
        '## C008 High risk <!-- oracle:cmd:true risk:high -->',
        '',
        '**Confidence**: observed',
        '',
        '## C009 Manual <!-- oracle:manual -->',
        '',
        '**Confidence**: observed',
        '',
        '## C010 Needs decision <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: observed',
        '**Human decision needed**: choose scope',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toEqual({
      promoted: ['C006'],
      retained: ['C007', 'C008', 'C009', 'C010'],
    })
    expect(readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).toContain('## C006 Eligible')
    expect(readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).not.toContain('## C007 Inferred')
  })

  test('accepts an observed candidate whose decision marker is none', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Eligible <!-- oracle:cmd:node%20--version -->',
        '',
        '**Confidence**: observed',
        '**Human decision needed**: none',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true).promoted).toEqual([
      'C006',
    ])
  })

  test('rejects a draft path that escapes staging', () => {
    const root = makeWorkspace()
    expect(() => promote(root, '.urtext/distill/spec-drafts/../spec-draft.md', 'specs/payments', true)).toThrow('draft')
  })

  test('rejects a candidate whose id exists anywhere in the target feature', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C001 Duplicate <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(() => promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toThrow('C001')
  })
  test('rejects promotion when the workspace has invalid distill declarations', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Eligible <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )
    writeFileSync(join(root, 'specs/payments/spec.md'), '## C001 Broken <!-- oracle:test:tests/missing.test.ts -->\n')

    expect(() => promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toThrow(
      'validation'
    )
    expect(() => readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).toThrow()
  })

  test('retains a candidate whose test oracle does not exist', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Missing test <!-- oracle:test:tests/missing.test.ts -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toEqual({
      promoted: [],
      retained: ['C006'],
    })
  })

  test('retains a candidate whose test oracle escapes the workspace', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    const outside = join(root, '..', 'outside.test.ts')
    writeFileSync(outside, 'export const outside = true\n')
    try {
      writeFileSync(
        join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
        [
          '# Candidate',
          '',
          `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
          '',
          '## C006 Escaped test <!-- oracle:test:../outside.test.ts -->',
          '',
          '**Confidence**: observed',
        ].join('\n')
      )

      expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toEqual({
        promoted: [],
        retained: ['C006'],
      })
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('retains a candidate whose command oracle is unavailable', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Missing command <!-- oracle:cmd:urtext-command-that-does-not-exist -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toEqual({
      promoted: [],
      retained: ['C006'],
    })
  })

  test('accepts an executable relative command oracle without executing it', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts/check.sh'), '#!/usr/bin/env sh\ntouch staged-command-ran\n')
    chmodSync(join(root, 'scripts/check.sh'), 0o755)
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        `**Facts manifest**: \`.urtext/distill/facts.json\` at \`${facts.workspaceHead}\``,
        '',
        '## C006 Relative command <!-- oracle:cmd:./scripts/check.sh -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toEqual({
      promoted: ['C006'],
      retained: [],
    })
    expect(existsSync(join(root, 'staged-command-ran'))).toBe(false)
  })

  test('rejects stale drafts without changing canonical clauses', () => {
    const root = makeWorkspace()
    mkdirSync(join(root, '.urtext/distill/spec-drafts/payments'), { recursive: true })
    writeFileSync(
      join(root, '.urtext/distill/spec-drafts/payments/spec-draft.md'),
      [
        '# Candidate',
        '',
        '**Facts manifest**: `.urtext/distill/facts.json` at `0000000000000000000000000000000000000000`',
        '',
        '## C001 Eligible <!-- oracle:cmd:true -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(() => promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toThrow('stale')
    expect(() => readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).toThrow()
  })
})
