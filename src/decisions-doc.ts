/**
 * Decision document parser — `docs/DECISIONS.md` is the source of truth for
 * addressable decision records referenced by clause `dec:` anchors.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseAnchorFields } from './anchor.js'

export interface DecisionEntry {
  decId: string
  title: string
  supersededBy: string | null
  line: number
}

export interface DecisionsDocError {
  code:
    | 'invalid_dec_id'
    | 'duplicate_dec_id'
    | 'unknown_supersede_target'
    | 'supersede_cycle'
    | 'malformed_anchor'
  decId?: string
  line: number
  message: string
}

export interface DecisionsDoc {
  entries: DecisionEntry[]
  errors: DecisionsDocError[]
}

const DECISION_LINE = /^(#{1,6})\s+([Dd]\d+)\b\s*(.*)$/
const CANONICAL_DEC_ID = /^D[1-9][0-9]*$/
const ANCHOR = /<!--\s*(.*?)\s*-->/

export const parseDecisionsDoc = (content: string): DecisionsDoc => {
  const entries: DecisionEntry[] = []
  const errors: DecisionsDocError[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)

  for (let line = 0; line < lines.length; line += 1) {
    const rawLine = lines[line]
    if (rawLine === undefined) continue
    const match = rawLine.match(DECISION_LINE)
    if (!match) continue
    const [, , decId = '', rest = ''] = match
    const anchorMatch = rest.match(ANCHOR)
    let supersededBy: string | null = null

    if (anchorMatch?.[1] !== undefined) {
      const parsed = parseAnchorFields(anchorMatch[1])
      for (const issue of parsed.issues) {
        errors.push({
          code: 'malformed_anchor',
          decId,
          line,
          message: `Decision "${decId}" anchor: ${issue.message}`,
        })
      }
      if (parsed.fields['superseded-by'] !== undefined) {
        supersededBy = parsed.fields['superseded-by']
      }
    }

    if (!CANONICAL_DEC_ID.test(decId)) {
      errors.push({
        code: 'invalid_dec_id',
        decId,
        line,
        message: `Decision id "${decId}" is not canonical; expected "D<n>" without leading zeroes.`,
      })
      continue
    }
    if (seen.has(decId)) {
      errors.push({
        code: 'duplicate_dec_id',
        decId,
        line,
        message: `Decision id "${decId}" is declared more than once.`,
      })
    }
    seen.add(decId)
    entries.push({
      decId,
      title: rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim(),
      supersededBy,
      line,
    })
  }

  const declared = new Set(entries.map((entry) => entry.decId))
  for (const entry of entries) {
    if (entry.supersededBy !== null && !declared.has(entry.supersededBy)) {
      errors.push({
        code: 'unknown_supersede_target',
        decId: entry.decId,
        line: entry.line,
        message: `Decision "${entry.decId}" supersedes unknown decision "${entry.supersededBy}".`,
      })
    }
  }

  const byId = new Map(entries.map((entry) => [entry.decId, entry]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const cycleReported = new Set<string>()
  const visit = (entry: DecisionEntry, trail: string[]): void => {
    const current = state.get(entry.decId)
    if (current === 'visited') return
    if (current === 'visiting') {
      const cycle = trail.slice(trail.indexOf(entry.decId))
      for (const decId of cycle) {
        if (cycleReported.has(decId)) continue
        cycleReported.add(decId)
        const member = byId.get(decId)
        if (member === undefined) continue
        errors.push({
          code: 'supersede_cycle',
          decId,
          line: member.line,
          message: `Decision "${decId}" participates in a supersede cycle.`,
        })
      }
      return
    }

    state.set(entry.decId, 'visiting')
    if (entry.supersededBy !== null) {
      const target = byId.get(entry.supersededBy)
      if (target !== undefined) visit(target, [...trail, entry.decId])
    }
    state.set(entry.decId, 'visited')
  }
  for (const entry of entries) visit(entry, [])

  return { entries, errors }
}

/** Load the workspace decision register; absent is the only nullable state. */
export const loadDecisionsDoc = (workspaceRoot: string): DecisionsDoc | null => {
  try {
    return parseDecisionsDoc(readFileSync(join(workspaceRoot, 'docs/DECISIONS.md'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
