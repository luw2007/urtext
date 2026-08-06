import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseAnchorFields, type AnchorParseIssue } from './anchor.js'

export interface InterfaceEntry {
  interfaceId: string
  title: string
  surfaces: string[]
  line: number
}

export interface ContractParseError {
  code: 'missing_surface' | 'duplicate_interface_id' | 'invalid_surface_path' | 'malformed_anchor'
  interfaceId?: string
  line: number
  message: string
}

export interface FeatureContract {
  contractPath: string
  entries: InterfaceEntry[]
}

const INTERFACE_LINE = /^(#{1,6})\s+(I\d+)\b\s*(.*)$/
const ANCHOR = /<!--\s*(.*?)\s*-->/

const isValidSurface = (surface: string): boolean =>
  !surface.startsWith('/') && !surface.includes('\\') && !surface.split('/').includes('..')

export const parseContractFile = (content: string): { entries: InterfaceEntry[]; errors: ContractParseError[] } => {
  const entries: InterfaceEntry[] = []
  const errors: ContractParseError[] = []
  const seenIds = new Set<string>()

  for (const [line, rawLine] of content.split(/\r?\n/).entries()) {
    const match = rawLine.match(INTERFACE_LINE)
    if (!match) continue

    const [, , interfaceId = '', rest = ''] = match
    const anchorMatch = rest.match(ANCHOR)
    let fields: Record<string, string> = {}
    if (anchorMatch?.[1] !== undefined) {
      const parsed = parseAnchorFields(anchorMatch[1])
      fields = parsed.fields
      for (const issue of parsed.issues) errors.push(toAnchorError(issue, line, interfaceId))
    }

    const surfaces: string[] = []
    if (fields.surface !== undefined) {
      for (const token of fields.surface.split(',')) {
        const surface = token.trim()
        if (!surface) continue
        if (!isValidSurface(surface)) {
          errors.push({
            code: 'invalid_surface_path',
            interfaceId,
            line,
            message: `Interface "${interfaceId}" surface "${surface}" must be a repo-root-relative POSIX path without ".." segments.`,
          })
          continue
        }
        surfaces.push(surface)
      }
    }
    if (surfaces.length === 0) {
      errors.push({
        code: 'missing_surface',
        interfaceId,
        line,
        message: `Interface "${interfaceId}" must declare at least one valid surface path.`,
      })
    }
    if (seenIds.has(interfaceId)) {
      errors.push({
        code: 'duplicate_interface_id',
        interfaceId,
        line,
        message: `Interface id "${interfaceId}" is declared more than once.`,
      })
    }
    seenIds.add(interfaceId)
    entries.push({
      interfaceId,
      title: rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim(),
      surfaces,
      line,
    })
  }

  return { entries, errors }
}

export const loadContracts = (
  workspaceRoot: string
): { contracts: FeatureContract[]; errors: (ContractParseError & { contractPath: string })[] } => {
  const specsDir = join(workspaceRoot, 'specs')
  let features: string[]
  try {
    features = readdirSync(specsDir)
      .filter((name) => statSync(join(specsDir, name)).isDirectory())
      .sort()
  } catch {
    return { contracts: [], errors: [] }
  }

  const contracts: FeatureContract[] = []
  const errors: (ContractParseError & { contractPath: string })[] = []
  for (const feature of features) {
    const contractPath = `specs/${feature}/contract.md`
    let content: string
    try {
      content = readFileSync(join(workspaceRoot, contractPath), 'utf8')
    } catch {
      continue
    }
    const parsed = parseContractFile(content)
    contracts.push({ contractPath, entries: parsed.entries })
    errors.push(...parsed.errors.map((error) => ({ ...error, contractPath })))
  }
  return { contracts, errors }
}

const toAnchorError = (issue: AnchorParseIssue, line: number, interfaceId: string): ContractParseError => ({
  code: 'malformed_anchor',
  interfaceId,
  line,
  message: `Interface "${interfaceId}": ${issue.message}`,
})
