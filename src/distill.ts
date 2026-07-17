import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { parseClauseFile, type ParsedClause } from './clause-parser.js'

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

const renderClause = (clause: ParsedClause): string => {
  const anchor = [
    `oracle:${clause.oracle!.kind}${clause.oracle!.ref ? `:${clause.oracle!.ref}` : ''}`,
    ...(clause.risk === 'high' ? ['risk:high'] : []),
    ...(clause.refs.length > 0 ? [`refs:${clause.refs.map((ref) => `${ref.path}#${ref.clauseId}`).join(',')}`] : []),
  ].join(' ')
  const body = clause.body
    ?.split('\n')
    .filter((line) => !/^\*\*(Confidence|Evidence|Human decision needed|Review decision)\*\*:/.test(line))
    .join('\n')
    .trim()
  return `## ${clause.clauseId} ${clause.title} <!-- ${anchor} -->${body ? `\n\n${body}` : ''}`
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
  const existingIds = new Set(
    listFiles(workspaceRoot, targetFeature)
      .filter((path) => path.endsWith('.md'))
      .flatMap((path) => parseClauseFile(readFileSync(join(workspaceRoot, path), 'utf8')).clauses)
      .map((clause) => clause.clauseId)
  )
  for (const clause of promoted) {
    if (existingIds.has(clause.clauseId)) throw new Error(`target already declares ${clause.clauseId}`)
  }
  if (promoted.length > 0) {
    writeFileSync(targetPath, `${existing ? `${existing}\n\n` : '# Executable clauses\n\n'}${promoted.map(renderClause).join('\n\n')}\n`)
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
    '  urtext distill promote <draft> --target <feature> --confirm',
    '                   Promote only observed low-risk runnable draft clauses after one feature-level confirmation.'
  ].join('\n')
