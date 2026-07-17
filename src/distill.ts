import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

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

export const discover = (workspaceRoot: string): DistillFacts => {
  const sourceFiles = listFiles(workspaceRoot, '.')
    .filter((path) => (path.endsWith('.ts') || path.endsWith('.go')) && !path.endsWith('.test.ts') && !path.endsWith('_test.go'))
    .sort()
  const testFiles = listFiles(workspaceRoot, '.')
    .filter((path) => path.endsWith('.test.ts') || path.endsWith('_test.go'))
    .sort()
  const facts: DistillFacts = {
    schema: 'urtext-distill-facts/v1',
    workspaceHead: gitHead(workspaceRoot),
    observed: {
      sourceFiles,
      testFiles,
      entrypoints: sourceFiles.filter((path) => path.endsWith('/cli.ts') || /^cmd\/[^/]+\/main\.go$/.test(path)),
    },
    declared: { features: featureDeclarations(workspaceRoot) },
  }
  const outputDir = join(workspaceRoot, '.urtext/distill')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`)
  return facts
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


export const distillUsage = (): string =>
  [
    '  urtext distill discover',
    '                   Write deterministic observed facts to .urtext/distill/facts.json without modifying canonical specs.',
    '  urtext distill coverage',
    '                   Report missing declared evidence and unowned observed files.',
    '  urtext distill validate',
    '                   Fail on missing declared evidence or test-oracle targets.',
  ].join('\n')
