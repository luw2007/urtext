import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { parseClauseFile } from '../src/clause-parser.js'
import { run } from '../src/cli.js'
import { baseline, baselineValidation, cluster, coverage, discover, distillUsage, l2IntentReview, l2IntentReviewValidation, promote, validate } from '../src/distill.js'

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
  writeFileSync(join(root, 'cmd/server/main_test.go'), 'package main\n')
  writeFileSync(
    join(root, 'specs/payments/spec.md'),
    [
      '# Payments',
      '',
      '## FR001 test intent',
      '',
      '## C001 Charges succeed <!-- oracle:test:tests/charge.test.ts req:FR001 -->',
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
  expect(distillUsage()).toContain('urtext distill cluster')
  expect(distillUsage()).toContain('urtext distill baseline')
  expect(distillUsage()).toContain('urtext distill l2')
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
    expect(manifest.observed.testFiles).toEqual(['cmd/server/main_test.go', 'internal/payments/charge_test.go', 'tests/charge.test.ts'])
    expect(manifest.observed.contractFiles).toEqual([])
    expect(manifest.observed.entrypoints).toEqual(['cmd/server/main.go', 'src/cli.ts'])

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
      'cmd/server/main_test.go',
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
        '## C001 Charges succeed <!-- oracle:test:tests/missing.test.ts req:FR001 -->',
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

  test('CLI distill validate exits 1 for an invalid declaration', () => {
    const root = makeWorkspace()
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      [
        '# Payments',
        '',
        '## C001 Charges succeed <!-- oracle:test:tests/missing.test.ts req:FR001 -->',
        '',
        '## Implementation Evidence',
        '',
        '- `src/missing.ts`',
      ].join('\n')
    )

    const previous = process.cwd()
    try {
      process.chdir(root)
      expect(run(['distill', 'validate'])).toBe(1)
    } finally {
      process.chdir(previous)
    }
  })

  test('validates test oracle targets even without implementation evidence', () => {
    const root = makeWorkspace()
    writeFileSync(
      join(root, 'specs/payments/spec.md'),
      '## C001 Charges succeed <!-- oracle:test:tests/missing.test.ts req:FR001 -->\n'
    )

    expect(validate(discover(root), root).errors).toEqual([
      {
        feature: 'specs/payments/spec.md',
        kind: 'missing_oracle_target',
        path: 'tests/missing.test.ts',
      },
    ])
  })


  test('clusters every observed source, test, and contract into deterministic structural domains', () => {
    const root = makeWorkspace()
    mkdirSync(join(root, 'internal/domain/payments'), { recursive: true })
    mkdirSync(join(root, 'contracts/payments'), { recursive: true })
    mkdirSync(join(root, 'misc'), { recursive: true })
    writeFileSync(join(root, 'internal/domain/payments/model.go'), 'package payments\n')
    writeFileSync(join(root, 'contracts/payments/api.proto'), 'syntax = "proto3";\n')
    writeFileSync(join(root, 'misc/config.yaml'), 'enabled: true\n')
    const manifest = cluster(discover(root), root)

    expect(manifest.schema).toBe('urtext-distill-domains/v1')
    expect(manifest.unclassified).toEqual([])
    expect(manifest.domains.find((domain) => domain.id === 'payments')).toEqual({
      contractFiles: ['contracts/payments/api.proto'],
      id: 'payments',
      sourceFiles: ['internal/domain/payments/model.go', 'internal/payments/charge.go'],
      testFiles: ['internal/payments/charge_test.go'],
    })
    expect(manifest.domains.find((domain) => domain.id === 'platform/misc')?.contractFiles).toEqual(['misc/config.yaml'])
    expect(readFileSync(join(root, '.urtext/distill/domains.json'), 'utf8')).toContain('urtext-distill-domains/v1')
  })

  test('groups every observed test into executable baseline clauses and reports untested domains as gaps', () => {
    const root = makeWorkspace()
    mkdirSync(join(root, 'web/src/modules/payments'), { recursive: true })
    writeFileSync(join(root, 'web/src/modules/payments/payment.test.ts'), 'export const payment = true\n')
    const facts = discover(root)
    const domains = cluster(facts, root)
    const report = baseline(facts, domains, root)

    expect(report.schema).toBe('urtext-distill-baseline/v1')
    expect(report.groups).toEqual([
      {
        clauseId: 'C001',
        command: ['go', 'test', './internal/payments'],
        domain: 'payments',
        id: 'payments-go-internal-payments',
        testFiles: ['internal/payments/charge_test.go'],
      },
      {
        clauseId: 'C002',
        command: ['pnpm', '--dir', 'web', 'exec', 'vitest', 'run', 'src/modules/payments/payment.test.ts'],
        domain: 'payments',
        id: 'payments-ts-web-src-modules-payments',
        testFiles: ['web/src/modules/payments/payment.test.ts'],
      },
      {
        clauseId: 'C001',
        command: ['npx', 'vitest', 'run', 'tests/charge.test.ts'],
        domain: 'platform/tests',
        id: 'platform-tests-ts-tests',
        testFiles: ['tests/charge.test.ts'],
      },
      {
        clauseId: 'C001',
        command: ['go', 'test', './cmd/server'],
        domain: 'server',
        id: 'server-go-cmd-server',
        testFiles: ['cmd/server/main_test.go'],
      },
    ])
    expect(report.gaps).toEqual(['platform/src: src/charge.ts', 'platform/src: src/cli.ts'])
    const baselineDoc = readFileSync(join(root, '.urtext/distill/baseline/payments.md'), 'utf8')
    expect(baselineDoc).toContain('## Baseline C001 — existing tests execute for payments')
    expect(parseClauseFile(baselineDoc).clauses).toEqual([])
    expect(baselineValidation(facts, domains, report)).toEqual({ errors: [] })
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
        '## C006 Eligible <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: observed',
        '',
        '## C007 Inferred <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: inferred',
        '',
        '## C008 High risk <!-- oracle:cmd:true risk:high req:FR001 -->',
        '',
        '**Confidence**: observed',
        '',
        '## C009 Manual <!-- oracle:manual req:FR001 -->',
        '',
        '**Confidence**: observed',
        '',
        '## C010 Needs decision <!-- oracle:cmd:true req:FR001 -->',
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
    expect(readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).toContain('req:FR001')
    expect(readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).not.toContain('## C007 Inferred')
  })

  test('promotion into a fresh feature carries the draft FR declarations it binds', () => {
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
        '## FR001 Observed payment behavior stays locked',
        '',
        'Recorded behavior keeps executing as observed.',
        '',
        '## C006 Eligible <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/newfeature', true).promoted).toEqual(['C006'])
    const written = parseClauseFile(readFileSync(join(root, 'specs/newfeature/clauses.md'), 'utf8'))
    expect(written.errors).toEqual([])
    expect(written.requirements.map((requirement) => requirement.reqId)).toEqual(['FR001'])
    expect(written.clauses.map((clause) => clause.clauseId)).toEqual(['C006'])
  })

  test('promotion into a fresh feature fails closed when neither draft nor target declares the bound FR', () => {
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
        '## C006 Eligible <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(() => promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/newfeature', true)).toThrow(
      'draft does not declare FR001'
    )
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
        '## C006 Eligible <!-- oracle:cmd:node%20--version req:FR001 -->',
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
        '## C001 Duplicate <!-- oracle:cmd:true req:FR001 -->',
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
        '## C006 Eligible <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )
    writeFileSync(join(root, 'specs/payments/spec.md'), '## C001 Broken <!-- oracle:test:tests/missing.test.ts req:FR001 -->\n')

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
        '## C006 Missing test <!-- oracle:test:tests/missing.test.ts req:FR001 -->',
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
          '## C006 Escaped test <!-- oracle:test:../outside.test.ts req:FR001 -->',
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
        '## C006 Missing command <!-- oracle:cmd:urtext-command-that-does-not-exist req:FR001 -->',
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
        '## C006 Relative command <!-- oracle:cmd:./scripts/check.sh req:FR001 -->',
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
        '## C001 Eligible <!-- oracle:cmd:true req:FR001 -->',
        '',
        '**Confidence**: observed',
      ].join('\n')
    )

    expect(() => promote(root, '.urtext/distill/spec-drafts/payments/spec-draft.md', 'specs/payments', true)).toThrow('stale')
    expect(() => readFileSync(join(root, 'specs/payments/clauses.md'), 'utf8')).toThrow()
  })

  test('renders one non-normative L2 review draft per structural domain', () => {
    const root = makeWorkspace()
    mkdirSync(join(root, 'internal/generated'), { recursive: true })
    writeFileSync(join(root, 'internal/generated/model.go'), 'package generated\n')
    const facts = discover(root)
    const domains = cluster(facts, root)
    const observedBaseline = baseline(facts, domains, root)

    const review = l2IntentReview(facts, domains, observedBaseline, root)

    expect(review.schema).toBe('urtext-distill-l2-intent-review/v1')
    expect(review.workspaceHead).toBe(facts.workspaceHead)
    expect(review.domains.map((domain) => domain.id)).toEqual(domains.domains.map((domain) => domain.id))
    expect(review.domains.find((domain) => domain.id === 'payments')).toMatchObject({
      id: 'payments',
      sourceFiles: ['internal/payments/charge.go'],
      contractFiles: [],
      testGroupIds: ['payments-go-internal-payments'],
    })
    const draft = readFileSync(join(root, '.urtext/distill/l2-generated-intent-drafts/payments/intent-review.md'), 'utf8')
    expect(draft).toContain('Human review required — not a canonical spec revision')
    expect(draft).toContain('does not assert product behavior')
    expect(draft).toContain('internal/payments/charge.go')
    expect(existsSync(join(root, '.urtext/distill/l2-generated-intent-drafts/generated/intent-review.md'))).toBe(true)
    expect(l2IntentReviewValidation(facts, domains, observedBaseline, review, root)).toEqual({ errors: [] })
  })

  test('removes stale L2 review drafts before rebuilding the current domain inventory', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    const domains = cluster(facts, root)
    const observedBaseline = baseline(facts, domains, root)
    const staleDraft = join(root, '.urtext/distill/l2-generated-intent-drafts/retired/intent-review.md')
    const humanDraft = join(root, '.urtext/distill/l2-intent-drafts/generated/intent-review.md')
    mkdirSync(join(root, '.urtext/distill/l2-generated-intent-drafts/retired'), { recursive: true })
    mkdirSync(join(root, '.urtext/distill/l2-intent-drafts/generated'), { recursive: true })
    writeFileSync(humanDraft, 'human decision\n')
    writeFileSync(staleDraft, 'obsolete review\n')

    l2IntentReview(facts, domains, observedBaseline, root)

    expect(existsSync(staleDraft)).toBe(false)
    expect(readFileSync(humanDraft, 'utf8')).toBe('human decision\n')
    expect(existsSync(join(root, '.urtext/distill/facts.json'))).toBe(true)
    expect(existsSync(join(root, '.urtext/distill/l2-intent-review.json'))).toBe(true)
  })

  test('rejects an L2 review inventory with a stale baseline head', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    const domains = cluster(facts, root)
    const observedBaseline = baseline(facts, domains, root)
    const review = l2IntentReview(facts, domains, observedBaseline, root)

    expect(
      l2IntentReviewValidation(facts, domains, { ...observedBaseline, workspaceHead: 'stale' }, review, root).errors
    ).toContain('workspace heads differ')
  })

  test('reports every L2 inventory integrity failure', () => {
    const root = makeWorkspace()
    const facts = discover(root)
    const domains = cluster(facts, root)
    const observedBaseline = baseline(facts, domains, root)
    const review = l2IntentReview(facts, domains, observedBaseline, root)
    const payments = review.domains.find((domain) => domain.id === 'payments')!
    const platformSource = review.domains.find((domain) => domain.id === 'platform/src')!

    expect(l2IntentReviewValidation(facts, domains, observedBaseline, { ...review, domains: review.domains.slice(1) }, root).errors).toContain(
      'structural domains are not assigned exactly once'
    )
    expect(
      l2IntentReviewValidation(
        facts,
        domains,
        observedBaseline,
        { ...review, domains: review.domains.map((domain) => domain.id === 'payments' ? { ...domain, testGroupIds: [] } : domain) },
        root
      ).errors
    ).toContain('payments has incorrect L1 groups')
    expect(
      l2IntentReviewValidation(
        facts,
        domains,
        observedBaseline,
        { ...review, domains: review.domains.map((domain) => domain.id === 'platform/src' ? { ...domain, deferredGaps: [] } : domain) },
        root
      ).errors
    ).toContain('platform/src has incorrect deferred gaps')

    rmSync(join(root, '.urtext/distill/l2-generated-intent-drafts', encodeURIComponent(payments.id)), { force: true, recursive: true })
    expect(l2IntentReviewValidation(facts, domains, observedBaseline, review, root).errors).toContain('payments is missing its L2 review draft')
    expect(platformSource.deferredGaps).toEqual(['src/charge.ts', 'src/cli.ts'])
    expect(readFileSync(join(root, '.urtext/distill/l2-generated-intent-drafts/platform%2Fsrc/intent-review.md'), 'utf8')).toContain(
      'This domain has no L1 executable group.'
    )
  })
})
