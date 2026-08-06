import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { parseClauseFile, type ParsedClause, type ParsedRequirement } from './clause-parser.js'

export interface FeatureDeclaration {
  path: string
  implementationEvidence: string[]
  testOracleTargets: string[]
}

export interface DistillFacts {
  schema: 'urtext-distill-facts/v1'
  workspaceHead: string | null
  observed: {
    sourceFiles: string[]
    testFiles: string[]
    contractFiles: string[]
    entrypoints: string[]
  }
  declared: {
    features: FeatureDeclaration[]
  }
}

export interface CoverageReport {
  missingEvidence: { feature: string; path: string }[]
  unownedObservedFiles: string[]
}

export interface ValidationReport {
  errors: { feature: string; kind: 'missing_evidence' | 'missing_oracle_target'; path: string }[]
}

export interface PromotionReport {
  promoted: string[]
  retained: string[]
}

export interface DomainCluster {
  id: string
  sourceFiles: string[]
  testFiles: string[]
  contractFiles: string[]
}

export interface DomainManifest {
  schema: 'urtext-distill-domains/v1'
  workspaceHead: string | null
  domains: DomainCluster[]
  unclassified: string[]
}

export interface ObservedBaselineGroup {
  id: string
  clauseId: string
  domain: string
  command: string[]
  testFiles: string[]
}

export interface ObservedBaseline {
  schema: 'urtext-distill-baseline/v1'
  workspaceHead: string | null
  groups: ObservedBaselineGroup[]
  gaps: string[]
}

export interface BaselineValidationReport {
  errors: string[]
}

export interface BaselineEvidence {
  schema: 'urtext-distill-baseline-evidence/v1'
  workspaceHead: string | null
  groups: { id: string; verdict: 'pass' | 'fail'; exitCode: number | null; output: string }[]
}

export interface L2IntentReviewDomain {
  id: string
  sourceFiles: string[]
  contractFiles: string[]
  testGroupIds: string[]
  deferredGaps: string[]
}

export interface L2IntentReviewManifest {
  schema: 'urtext-distill-l2-intent-review/v1'
  workspaceHead: string | null
  domains: L2IntentReviewDomain[]
}

const toPosix = (path: string): string => path.split(sep).join('/')

const EXCLUDED_DIRECTORIES: Record<string, true> = {
  '.git': true,
  '.urtext': true,
  dist: true,
  node_modules: true,
}

const listFiles = (root: string, directory: string): string[] => {
  const absolute = join(root, directory)
  try {
    const entries = readdirSync(absolute, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES[entry.name] !== true) files.push(...listFiles(root, child))
      if (entry.isFile()) files.push(toPosix(child))
    }
    return files
  } catch {
    return []
  }
}

const fileExists = (root: string, path: string): boolean => {
  try {
    return statSync(join(root, path)).isFile()
  } catch {
    return false
  }
}

const evidenceExists = (root: string, path: string): boolean => {
  if (!path.includes('*')) {
    try {
      statSync(join(root, path))
      return true
    } catch {
      return false
    }
  }
  const expression = new RegExp(`^${path.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return listFiles(root, '.').some((file) => expression.test(file))
}

const evidenceOwns = (evidence: string, file: string): boolean => {
  if (evidence.includes('*')) {
    const expression = new RegExp(`^${evidence.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return expression.test(file)
  }
  return evidence.endsWith('/') ? file.startsWith(evidence) : evidence === file
}

const extractImplementationEvidence = (content: string): string[] => {
  const heading = /^#{1,6}\s+Implementation Evidence\s*$/im.exec(content)
  if (!heading || heading.index === undefined) return []
  const section = content.slice(heading.index + heading[0].length)
  const untilNextHeading = section.search(/^#{1,6}\s+/m)
  const body = untilNextHeading < 0 ? section : section.slice(0, untilNextHeading)
  return [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).sort()
}

const extractTestOracleTargets = (content: string): string[] =>
  [...content.matchAll(/<!--\s*[^>]*\boracle:test:([^\s>]+)[^>]*-->/g)].map((match) => match[1]!).sort()

const gitHead = (root: string): string | null => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const featureDeclarations = (root: string): FeatureDeclaration[] =>
  listFiles(root, 'specs')
    .filter((path) => path.endsWith('.md') && !path.endsWith('/tasks.md'))
    .map((path) => {
      const content = readFileSync(join(root, path), 'utf8')
      return {
        path,
        implementationEvidence: extractImplementationEvidence(content),
        testOracleTargets: extractTestOracleTargets(content),
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))

const isContractFile = (path: string): boolean =>
  path.endsWith('.proto') || path.endsWith('.sql') || path.endsWith('.yaml') || path.endsWith('.yml')

const domainFor = (path: string): string => {
  const parts = path.split('/')
  const [first, second, third, fourth] = parts
  if (first === 'internal' && ['app', 'domain', 'infra'].includes(second ?? '') && third) return third
  if (first === 'internal' && second) return second
  if (first === 'cmd' && second) return second
  if (first === 'web' && second === 'src' && third === 'modules' && fourth) return fourth
  if ((first === 'contracts' || first === 'api') && second) return second
  return `platform/${first ?? 'root'}`
}

export const discover = (workspaceRoot: string): DistillFacts => {
  const sourceFiles = listFiles(workspaceRoot, '.')
    .filter((path) => (path.endsWith('.ts') || path.endsWith('.go')) && !path.endsWith('.test.ts') && !path.endsWith('_test.go'))
    .sort()
  const testFiles = listFiles(workspaceRoot, '.')
    .filter((path) => path.endsWith('.test.ts') || path.endsWith('_test.go'))
    .sort()
  const contractFiles = listFiles(workspaceRoot, '.').filter(isContractFile).sort()
  const facts: DistillFacts = {
    schema: 'urtext-distill-facts/v1',
    workspaceHead: gitHead(workspaceRoot),
    observed: {
      sourceFiles,
      testFiles,
      contractFiles,
      entrypoints: sourceFiles.filter((path) => path.endsWith('/cli.ts') || /^cmd\/[^/]+\/main\.go$/.test(path)),
    },
    declared: { features: featureDeclarations(workspaceRoot) },
  }
  const outputDir = join(workspaceRoot, '.urtext/distill')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`)
  return facts
}

export const cluster = (facts: DistillFacts, workspaceRoot?: string): DomainManifest => {
  const buckets = new Map<string, DomainCluster>()
  const add = (path: string, kind: keyof Omit<DomainCluster, 'id'>) => {
    const id = domainFor(path)
    const bucket = buckets.get(id) ?? { id, sourceFiles: [], testFiles: [], contractFiles: [] }
    bucket[kind].push(path)
    buckets.set(id, bucket)
  }
  for (const path of facts.observed.sourceFiles) add(path, 'sourceFiles')
  for (const path of facts.observed.testFiles) add(path, 'testFiles')
  for (const path of facts.observed.contractFiles) add(path, 'contractFiles')
  const domains = [...buckets.values()]
    .map((domain) => ({
      ...domain,
      sourceFiles: domain.sourceFiles.sort(),
      testFiles: domain.testFiles.sort(),
      contractFiles: domain.contractFiles.sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const manifest: DomainManifest = {
    schema: 'urtext-distill-domains/v1',
    workspaceHead: facts.workspaceHead,
    domains,
    unclassified: [],
  }
  const root = workspaceRoot ?? process.cwd()
  const outputDir = join(root, '.urtext/distill')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'domains.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

const goToolchain = (workspaceRoot: string): string[] => {
  try {
    return /^go 1\.25(?:\.0)?$/m.test(readFileSync(join(workspaceRoot, 'go.mod'), 'utf8')) ? ['GOTOOLCHAIN=go1.25.0'] : []
  } catch {
    return []
  }
}

const baselineGroupId = (domain: string, language: string, directory: string): string =>
  `${domain.replace(/\//g, '-')}-${language}-${directory.replace(/^\.\//, '').replace(/\//g, '-')}`

const commandFor = (testFiles: string[], workspaceRoot: string): string[] => {
  const first = testFiles[0]!
  if (first.endsWith('_test.go')) {
    const directory = dirname(first)
    return [...goToolchain(workspaceRoot), 'go', 'test', `./${directory}`]
  }
  if (first.startsWith('web/')) {
    return ['pnpm', '--dir', 'web', 'exec', 'vitest', 'run', ...testFiles.map((path) => path.slice('web/'.length))]
  }
  return ['npx', 'vitest', 'run', ...testFiles]
}

const encodedCommand = (command: string[]): string =>
  command[0]?.startsWith('GOTOOLCHAIN=') ? ['env', ...command].join('%20') : command.join('%20')

const renderBaselineClauses = (domain: string, groups: ObservedBaselineGroup[]): string =>
  [
    `# Observed executable baseline: ${domain}`,
    '',
    '**Status**: Observed fact baseline — not product intent',
    '',
    ...groups.flatMap((group) => [
      `## Baseline ${group.clauseId} — existing tests execute for ${domain} <!-- oracle:cmd:${encodedCommand(group.command)} -->`,
      '',
      `Given the recorded workspace HEAD,`,
      `When ${group.testFiles.map((path) => `\`${path}\``).join(', ')} run,`,
      'Then the command records their executable evidence without asserting their implied product behavior.',
      '',
      `**Confidence**: observed`,
      `**Evidence**: ${group.testFiles.map((path) => `\`${path}\``).join(', ')}`,
      '',
    ]),
  ].join('\n')

export const baseline = (facts: DistillFacts, domains: DomainManifest, workspaceRoot?: string): ObservedBaseline => {
  const root = workspaceRoot ?? process.cwd()
  const groups: ObservedBaselineGroup[] = []
  const domainsWithTests = new Set<string>()
  for (const domain of domains.domains) {
    const partitions = new Map<string, string[]>()
    for (const testFile of domain.testFiles) {
      const language = testFile.endsWith('_test.go') ? 'go' : 'ts'
      const directory = language === 'go' ? dirname(testFile) : testFile.startsWith('web/') ? dirname(testFile) : dirname(testFile)
      const key = `${language}:${directory}`
      const files = partitions.get(key) ?? []
      files.push(testFile)
      partitions.set(key, files)
    }
    for (const [key, testFiles] of partitions) {
      const [language, directory] = key.split(':') as [string, string]
      const sortedFiles = testFiles.sort()
      groups.push({
        id: baselineGroupId(domain.id, language, directory),
        clauseId: `C${String(groups.filter((group) => group.domain === domain.id).length + 1).padStart(3, '0')}`,
        domain: domain.id,
        command: commandFor(sortedFiles, root),
        testFiles: sortedFiles,
      })
      domainsWithTests.add(domain.id)
    }
  }
  const gaps = domains.domains
    .filter((domain) => !domainsWithTests.has(domain.id))
    .flatMap((domain) => [...domain.sourceFiles, ...domain.contractFiles].map((path) => `${domain.id}: ${path}`))
    .sort()
  const manifest: ObservedBaseline = {
    schema: 'urtext-distill-baseline/v1',
    workspaceHead: facts.workspaceHead,
    groups: groups.sort((a, b) => a.id.localeCompare(b.id)),
    gaps,
  }
  const outputDir = join(root, '.urtext/distill')
  const baselineDir = join(outputDir, 'baseline')
  mkdirSync(baselineDir, { recursive: true })
  for (const domain of domains.domains) {
    const domainGroups = manifest.groups.filter((group) => group.domain === domain.id)
    if (domainGroups.length > 0) writeFileSync(join(baselineDir, `${domain.id.replace(/\//g, '__')}.md`), renderBaselineClauses(domain.id, domainGroups))
  }
  writeFileSync(join(outputDir, 'baseline.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export const baselineValidation = (
  facts: DistillFacts,
  domains: DomainManifest,
  manifest: ObservedBaseline
): BaselineValidationReport => {
  const errors: string[] = []
  if (facts.workspaceHead !== domains.workspaceHead || facts.workspaceHead !== manifest.workspaceHead) errors.push('workspace heads differ')
  const expected = domains.domains.flatMap((domain) => domain.testFiles).sort()
  const assigned = manifest.groups.flatMap((group) => group.testFiles).sort()
  if (expected.length !== assigned.length || expected.some((path, index) => path !== assigned[index])) {
    errors.push('observed tests are not assigned exactly once')
  }
  for (const group of manifest.groups) {
    if (group.command.length === 0) errors.push(`${group.id} has no command`)
  }
  return { errors }
}

const L2_GENERATED_ROOT = '.urtext/distill/l2-generated-intent-drafts'

const l2GeneratedDraftPath = (domain: string): string =>
  `${L2_GENERATED_ROOT}/${encodeURIComponent(domain)}/intent-review.md`

const renderL2IntentReview = (domain: L2IntentReviewDomain, workspaceHead: string | null): string =>
  [
    `# L2 Intent Review: ${domain.id}`,
    '',
    '**Status**: Human review required — not a canonical spec revision',
    `**Facts HEAD**: \`${workspaceHead ?? 'unavailable'}\``,
    '',
    '## Fact boundary',
    '',
    `- Structural domain: \`${domain.id}\`. This is an L0 ownership bucket, not a product boundary.`,
    `- Observed source files (${domain.sourceFiles.length}): ${domain.sourceFiles.length > 0 ? domain.sourceFiles.map((path) => `\`${path}\``).join(', ') : 'none'}.`,
    `- Observed contract files (${domain.contractFiles.length}): ${domain.contractFiles.length > 0 ? domain.contractFiles.map((path) => `\`${path}\``).join(', ') : 'none'}.`,
    `- L1 executable groups (${domain.testGroupIds.length}): ${domain.testGroupIds.length > 0 ? domain.testGroupIds.map((id) => `\`${id}\``).join(', ') : 'none'}.`,
    `- L1 deferred gaps (${domain.deferredGaps.length}): ${domain.deferredGaps.length > 0 ? domain.deferredGaps.map((path) => `\`${path}\``).join(', ') : 'none'}.`,
    '',
    'L0 files and L1 groups are observed facts only. This review does not assert product behavior, create functional requirements, or authorize canonical-spec changes.',
    '',
    '## Human intent decision',
    '',
    'Choose one: accept this structural domain as an L2 review boundary; revise it by naming the intended product boundary and vocabulary; split or merge it with named domains; or defer it as non-behavioral glue / missing oracle / cross-domain contract / intentional exclusion.',
    '',
    '## Evidence adequacy',
    '',
    domain.deferredGaps.length > 0
      ? 'This domain has no L1 executable group. Resolve its deferred gaps before deriving requirement-level product intent.'
      : 'Existing L1 groups establish test execution only. Requirement-level intent still requires human adjudication and, for high-risk semantics, a requirement-level oracle.',
    '',
  ].join('\n')

const indexBaselineByDomain = (observedBaseline: ObservedBaseline): {
  groupsByDomain: Map<string, string[]>
  gapsByDomain: Map<string, string[]>
} => {
  const groupsByDomain = new Map<string, string[]>()
  for (const group of observedBaseline.groups) {
    const groups = groupsByDomain.get(group.domain) ?? []
    groups.push(group.id)
    groupsByDomain.set(group.domain, groups)
  }
  const gapsByDomain = new Map<string, string[]>()
  for (const gap of observedBaseline.gaps) {
    const separator = gap.indexOf(': ')
    if (separator < 0) continue
    const id = gap.slice(0, separator)
    const paths = gapsByDomain.get(id) ?? []
    paths.push(gap.slice(separator + 2))
    gapsByDomain.set(id, paths)
  }
  return { groupsByDomain, gapsByDomain }
}

export const l2IntentReview = (
  facts: DistillFacts,
  domains: DomainManifest,
  observedBaseline: ObservedBaseline,
  workspaceRoot?: string
): L2IntentReviewManifest => {
  const root = workspaceRoot ?? process.cwd()
  const { groupsByDomain, gapsByDomain } = indexBaselineByDomain(observedBaseline)
  const manifest: L2IntentReviewManifest = {
    schema: 'urtext-distill-l2-intent-review/v1',
    workspaceHead: facts.workspaceHead,
    domains: domains.domains.map((domain) => ({
      id: domain.id,
      sourceFiles: domain.sourceFiles,
      contractFiles: domain.contractFiles,
      testGroupIds: (groupsByDomain.get(domain.id) ?? []).sort(),
      deferredGaps: (gapsByDomain.get(domain.id) ?? []).sort(),
    })),
  }
  const generatedRoot = join(root, L2_GENERATED_ROOT)
  rmSync(generatedRoot, { force: true, recursive: true })
  mkdirSync(generatedRoot, { recursive: true })
  const outputDir = join(root, '.urtext/distill')
  for (const domain of manifest.domains) {
    const path = join(root, l2GeneratedDraftPath(domain.id))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${renderL2IntentReview(domain, facts.workspaceHead)}\n`)
  }
  writeFileSync(join(outputDir, 'l2-intent-review.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export const l2IntentReviewValidation = (
  facts: DistillFacts,
  domains: DomainManifest,
  observedBaseline: ObservedBaseline,
  review: L2IntentReviewManifest,
  workspaceRoot?: string
): BaselineValidationReport => {
  const errors: string[] = []
  if (
    facts.workspaceHead !== domains.workspaceHead ||
    facts.workspaceHead !== observedBaseline.workspaceHead ||
    facts.workspaceHead !== review.workspaceHead
  ) {
    errors.push('workspace heads differ')
  }
  const expected = domains.domains.map((domain) => domain.id)
  const actual = review.domains.map((domain) => domain.id)
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    errors.push('structural domains are not assigned exactly once')
  }
  const { groupsByDomain, gapsByDomain } = indexBaselineByDomain(observedBaseline)
  const root = workspaceRoot ?? process.cwd()
  for (const domain of review.domains) {
    const expectedGroups = (groupsByDomain.get(domain.id) ?? []).sort()
    const expectedGaps = (gapsByDomain.get(domain.id) ?? []).sort()
    if (domain.testGroupIds.join('\n') !== expectedGroups.join('\n')) errors.push(`${domain.id} has incorrect L1 groups`)
    if (domain.deferredGaps.join('\n') !== expectedGaps.join('\n')) errors.push(`${domain.id} has incorrect deferred gaps`)
    if (!fileExists(root, l2GeneratedDraftPath(domain.id))) errors.push(`${domain.id} is missing its L2 review draft`)
  }
  return { errors }
}

export const runBaseline = (manifest: ObservedBaseline, workspaceRoot: string): BaselineEvidence => {
  const groups = manifest.groups.map((group) => {
    const [maybeEnv, command, ...args] = group.command
    const env = maybeEnv?.startsWith('GOTOOLCHAIN=') ? { ...process.env, GOTOOLCHAIN: maybeEnv.slice('GOTOOLCHAIN='.length) } : process.env
    const result = spawnSync(maybeEnv?.startsWith('GOTOOLCHAIN=') ? command! : maybeEnv!, maybeEnv?.startsWith('GOTOOLCHAIN=') ? args : [command!, ...args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 300_000,
      env,
    })
    return {
      id: group.id,
      verdict: result.status === 0 && !result.error ? ('pass' as const) : ('fail' as const),
      exitCode: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 4_000),
    }
  })
  const evidence: BaselineEvidence = { schema: 'urtext-distill-baseline-evidence/v1', workspaceHead: manifest.workspaceHead, groups }
  writeFileSync(join(workspaceRoot, '.urtext/distill/baseline-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}

export const coverage = (facts: DistillFacts, workspaceRoot?: string): CoverageReport => {
  const root = workspaceRoot ?? process.cwd()
  const observed = [...facts.observed.sourceFiles, ...facts.observed.testFiles]
  const declaredEvidence = facts.declared.features.flatMap((feature) => feature.implementationEvidence)
  return {
    missingEvidence: facts.declared.features
      .flatMap((feature) =>
        feature.implementationEvidence
          .filter((path) => !evidenceExists(root, path))
          .map((path) => ({ feature: feature.path, path }))
      )
      .sort((a, b) => a.feature.localeCompare(b.feature) || a.path.localeCompare(b.path)),
    unownedObservedFiles: observed
      .filter((file) => !declaredEvidence.some((evidence) => evidenceOwns(evidence, file)))
      .sort(),
  }
}

export const validate = (facts: DistillFacts, workspaceRoot?: string): ValidationReport => {
  const root = workspaceRoot ?? process.cwd()
  const errors: ValidationReport['errors'] = []
  for (const feature of facts.declared.features) {
    for (const path of feature.implementationEvidence) {
      if (!evidenceExists(root, path)) errors.push({ feature: feature.path, kind: 'missing_evidence', path })
    }
    for (const path of feature.testOracleTargets) {
      if (!fileExists(root, path)) errors.push({ feature: feature.path, kind: 'missing_oracle_target', path })
    }
  }
  return {
    errors: errors.sort(
      (a, b) => a.feature.localeCompare(b.feature) || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)
    ),
  }
}

const DRAFT_ROOT = '.urtext/distill/spec-drafts/'

const hasPendingHumanDecision = (body: string | null): boolean =>
  (body ?? '').split('\n').some((line) => {
    const match = /^\*\*Human decision needed\*\*:\s*(.*)$/.exec(line)
    return match !== null && match[1]?.trim().toLowerCase() !== 'none'
  })

const hasExistingTestOracle = (clause: ParsedClause, workspaceRoot: string): boolean => {
  if (clause.oracle?.kind !== 'test') return true
  const reference = clause.oracle.ref
  return reference !== null && !reference.includes('..') && !reference.startsWith('/') && fileExists(workspaceRoot, reference)
}

const hasResolvableCommandOracle = (clause: ParsedClause, workspaceRoot: string): boolean => {
  if (clause.oracle?.kind !== 'cmd') return true
  const command = clause.oracle.ref?.split('%20')[0]
  if (!command || command.includes('..') || command.startsWith('/')) return false
  if (command.startsWith('./')) {
    try {
      return statSync(join(workspaceRoot, command)).isFile() && (statSync(join(workspaceRoot, command)).mode & 0o111) !== 0
    } catch {
      return false
    }
  }
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const isEligible = (clause: ParsedClause, workspaceRoot: string): boolean =>
  (clause.oracle?.kind === 'test' || clause.oracle?.kind === 'cmd') &&
  clause.oracle.ref !== null &&
  clause.risk === 'low' &&
  clause.body?.includes('**Confidence**: observed') === true &&
  !hasPendingHumanDecision(clause.body) &&
  hasExistingTestOracle(clause, workspaceRoot) && hasResolvableCommandOracle(clause, workspaceRoot)

const stripReviewMarkers = (body: string | null): string =>
  body
    ?.split('\n')
    .filter((line) => !/^\*\*(Confidence|Evidence|Human decision needed|Review decision)\*\*:/.test(line))
    .join('\n')
    .trim() ?? ''

const renderClause = (clause: ParsedClause): string => {
  const anchor = [
    `oracle:${clause.oracle!.kind}${clause.oracle!.ref ? `:${clause.oracle!.ref}` : ''}`,
    ...(clause.risk === 'high' ? ['risk:high'] : []),
    ...(clause.refs.length > 0 ? [`refs:${clause.refs.map((ref) => `${ref.path}#${ref.clauseId}`).join(',')}`] : []),
    ...(clause.decs.length > 0 ? [`dec:${clause.decs.join(',')}`] : []),
    ...(clause.reqs.length > 0 ? [`req:${clause.reqs.map((req) => req.path === null ? req.reqId : `${req.path}#${req.reqId}`).join(',')}`] : []),
  ].join(' ')
  const body = stripReviewMarkers(clause.body)
  return `## ${clause.clauseId} ${clause.title} <!-- ${anchor} -->${body ? `\n\n${body}` : ''}`
}

const renderRequirement = (requirement: ParsedRequirement): string => {
  const body = stripReviewMarkers(requirement.body)
  return `## ${requirement.reqId} ${requirement.title}${body ? `\n\n${body}` : ''}`
}

export const promote = (
  workspaceRoot: string,
  draftPath: string,
  targetFeature: string,
  confirmed: boolean
): PromotionReport => {
  if (!confirmed) throw new Error('feature-level confirmation is required')
  if (!draftPath.startsWith(DRAFT_ROOT) || draftPath.includes('..')) {
    throw new Error(`draft must live under ${DRAFT_ROOT}`)
  }
  if (!targetFeature.startsWith('specs/') || targetFeature.includes('..')) throw new Error('target must be a feature under specs/')

  const content = readFileSync(join(workspaceRoot, draftPath), 'utf8')
  const head = content.match(/^\*\*Facts manifest\*\*: .* at `([0-9a-f]{40})`$/m)?.[1]
  if (!head || head !== gitHead(workspaceRoot)) throw new Error('stale draft facts manifest')

  const validation = validate(discover(workspaceRoot), workspaceRoot)
  if (validation.errors.length > 0) throw new Error('distill validation failed')

  const parsed = parseClauseFile(content)
  if (parsed.errors.length > 0) throw new Error('draft contains invalid clause syntax')

  const promoted: ParsedClause[] = []
  const retained: string[] = []
  for (const clause of parsed.clauses) {
    if (isEligible(clause, workspaceRoot)) promoted.push(clause)
    else retained.push(clause.clauseId)
  }

  const targetPath = join(workspaceRoot, targetFeature, 'clauses.md')
  let existing = ''
  try {
    existing = readFileSync(targetPath, 'utf8').trimEnd()
  } catch {
    mkdirSync(join(workspaceRoot, targetFeature), { recursive: true })
  }
  const targetFiles = listFiles(workspaceRoot, targetFeature)
    .filter((path) => path.endsWith('.md'))
    .map((path) => parseClauseFile(readFileSync(join(workspaceRoot, path), 'utf8')))
  const existingIds = new Set(targetFiles.flatMap((file) => file.clauses).map((clause) => clause.clauseId))
  const existingReqIds = new Set(targetFiles.flatMap((file) => file.requirements).map((requirement) => requirement.reqId))
  for (const clause of promoted) {
    if (existingIds.has(clause.clauseId)) throw new Error(`target already declares ${clause.clauseId}`)
  }
  // A promotion must leave a workspace that still checks clean: carry the
  // draft's declarations for unit-local reqs the target does not declare.
  const draftRequirements = new Map(parsed.requirements.map((requirement) => [requirement.reqId, requirement]))
  const carried: ParsedRequirement[] = []
  for (const clause of promoted) {
    for (const req of clause.reqs) {
      if (req.path !== null || existingReqIds.has(req.reqId)) continue
      const declaration = draftRequirements.get(req.reqId)
      if (!declaration) throw new Error(`draft does not declare ${req.reqId}`)
      carried.push(declaration)
      existingReqIds.add(req.reqId)
    }
  }
  if (promoted.length > 0) {
    const sections = [...carried.map(renderRequirement), ...promoted.map(renderClause)]
    writeFileSync(targetPath, `${existing ? `${existing}\n\n` : '# Executable clauses\n\n'}${sections.join('\n\n')}\n`)
  }
  return { promoted: promoted.map((clause) => clause.clauseId), retained }
}


export const distillUsage = (): string =>
  [
    '  urtext distill discover',
    '                   Write deterministic observed facts to .urtext/distill/facts.json without modifying canonical specs.',
    '  urtext distill coverage',
    '                   Report missing declared evidence and unowned observed files.',
    '  urtext distill validate',
    '                   Fail on missing declared evidence or test-oracle targets.',
    '  urtext distill cluster',
    '                   Write a deterministic domain inventory to .urtext/distill/domains.json without asserting behavior.',
    '  urtext distill baseline [validate|run]',
    '                   Write observed executable test groups to .urtext/distill/baseline.json; validate or run without modifying canonical specs.',
    '  urtext distill l2 [validate]',
    '                   Write one non-normative L2 intent-review draft per structural domain without modifying canonical specs.',
    '  urtext distill promote <draft> --target <feature> --confirm',
    '                   Promote only observed low-risk runnable draft clauses after one feature-level confirmation.'
  ].join('\n')
