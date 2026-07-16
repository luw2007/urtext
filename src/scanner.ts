/**
 * Workspace scanner — discovers feature units and reconciles them into the
 * registry in dependency order (clause files before the checklist, so
 * `unknown_clause` checks see the unit's declared ids).
 *
 * v0 is scan-on-demand (`urtext index`), not a resident watcher: git-native,
 * serverless (VISION P8). A watcher can wrap these same pure functions later.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Database } from 'better-sqlite3'

import { parseClauseFile } from './clause-parser.js'
import { linkWorkspace, propagateStale, type LinkError, type StaleReport } from './linker.js'
import { indexClauseFile, indexTaskFile, type IndexOutcome } from './registry.js'

export interface FeatureUnit {
  /** Feature directory name, e.g. `coupon`. */
  feature: string
  /** Workspace-relative clause file paths (posix separators). */
  clauseFiles: string[]
  /** Workspace-relative checklist path, when present. */
  taskFile: string | null
}

export interface ScanReport {
  units: FeatureUnit[]
  outcomes: { specPath: string; outcome: IndexOutcome }[]
  /** Workspace-level `unknown_ref` errors (SYNTAX.md: check-stage, fail-closed). */
  linkErrors: LinkError[]
  /** Dependents of text-changed clauses; their evidence was invalidated. */
  stale: StaleReport
}

/** Discover `specs/<feature>/` units. Non-recursive below the feature dir (v0). */
export const discoverUnits = (workspaceRoot: string): FeatureUnit[] => {
  const specsDir = join(workspaceRoot, 'specs')
  let featureNames: string[]
  try {
    featureNames = readdirSync(specsDir).filter((name) => {
      try {
        return statSync(join(specsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }

  const units: FeatureUnit[] = []
  for (const feature of featureNames.sort()) {
    const featureDir = join(specsDir, feature)
    const entries = readdirSync(featureDir).filter((name) => name.endsWith('.md'))
    const clauseFiles = entries
      .filter((name) => name !== 'tasks.md')
      .sort()
      .map((name) => `specs/${feature}/${name}`)
    const taskFile = entries.includes('tasks.md') ? `specs/${feature}/tasks.md` : null
    if (clauseFiles.length > 0 || taskFile) {
      units.push({ feature, clauseFiles, taskFile })
    }
  }
  return units
}

/** Scan the workspace and reconcile every discovered file into the registry. */
export const scanWorkspace = (db: Database, workspaceRoot: string): ScanReport => {
  const units = discoverUnits(workspaceRoot)
  const outcomes: ScanReport['outcomes'] = []
  const timestamp = Date.now()

  const changed: { specPath: string; clauseId: string }[] = []
  for (const unit of units) {
    // Clause files first — collect the unit's declared ids for the checklist check.
    const unitClauseIds = new Set<string>()
    for (const specPath of unit.clauseFiles) {
      const content = readFileSync(join(workspaceRoot, specPath), 'utf8')
      for (const clause of parseClauseFile(content).clauses) {
        unitClauseIds.add(clause.clauseId)
      }
      const outcome = indexClauseFile(db, { specPath, content, timestamp })
      if (outcome.kind === 'indexed') {
        for (const clauseId of outcome.changedClauses) changed.push({ specPath, clauseId })
      }
      outcomes.push({ specPath, outcome })
    }

    if (unit.taskFile) {
      const content = readFileSync(join(workspaceRoot, unit.taskFile), 'utf8')
      outcomes.push({
        specPath: unit.taskFile,
        outcome: indexTaskFile(db, { specPath: unit.taskFile, content, timestamp, unitClauseIds }),
      })
    }
  }

  // Link pass over the reconciled snapshot: cross-file ref validation, then
  // stale propagation from every clause whose normative text changed.
  const linkErrors = linkWorkspace(db)
  const stale = propagateStale(db, changed, timestamp)

  return { units, outcomes, linkErrors, stale }
}
