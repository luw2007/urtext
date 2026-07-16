/**
 * Parser for Urtext clause files — any `specs/<feature>/*.md` except
 * `tasks.md`. A clause is a heading carrying a stable `C\d+` id plus the prose
 * body that follows it (up to the next heading of any level).
 *
 *   ## C001 优惠券不可叠加 <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:billing/spec.md#C003 -->
 *   Given 已折扣商品 When 应用优惠券 Then 拒绝并返回 409
 *
 * Headings WITHOUT a `C\d+` id are ordinary prose and impose nothing. Only a
 * declared clause enters the verification system — and a declared clause MUST
 * bind an oracle (VISION P1): a normative statement that cannot be checked is
 * an authoring error, not a softer kind of truth.
 *
 * Everything is fail-closed: any error keeps the revision at `building`.
 */

import { parseAnchorFields, type AnchorParseIssue } from './anchor.js'

export const ORACLE_KINDS = ['test', 'cmd', 'metric', 'diff-scope', 'manual'] as const
export type OracleKind = (typeof ORACLE_KINDS)[number]

export interface ClauseOracle {
  kind: OracleKind
  /** Kind-specific reference (test pattern, command, metric expression, glob). */
  ref: string | null
}

export interface ClauseRef {
  /** Workspace-relative spec path, e.g. `specs/billing/spec.md`. */
  path: string
  clauseId: string
}

export interface ParsedClause {
  /** Stable in-file id, e.g. `C001`. Unique within the file. */
  clauseId: string
  /** 1-based order of appearance. */
  seq: number
  title: string
  /** Heading level 1-6, kept for round-tripping. */
  level: number
  oracle: ClauseOracle | null
  risk: 'low' | 'high'
  refs: ClauseRef[]
  /** Prose between this heading and the next heading; null when empty. */
  body: string | null
  /** 0-based line index of the heading, for error anchoring. */
  line: number
}

export interface ClauseParseError {
  code:
    | 'missing_oracle'
    | 'invalid_oracle_kind'
    | 'invalid_risk'
    | 'duplicate_clause_id'
    | 'malformed_anchor'
    | 'malformed_ref'
  clauseId?: string
  line: number
  message: string
}

export interface ParsedClauseFile {
  clauses: ParsedClause[]
  errors: ClauseParseError[]
}

// `## C001 Title …` — capture heading depth, clause id, and the rest.
const CLAUSE_LINE = /^(#{1,6})\s+(C\d+)\b\s*(.*)$/
// Any heading terminates the previous clause body.
const ANY_HEADING = /^#{1,6}\s+/
const ANCHOR = /<!--\s*(.*?)\s*-->/

export const isOracleKind = (value: string): value is OracleKind =>
  (ORACLE_KINDS as readonly string[]).includes(value)

const parseOracle = (
  value: string | undefined,
  line: number,
  clauseId: string
): { oracle: ClauseOracle | null; error?: ClauseParseError } => {
  if (value === undefined) {
    return {
      oracle: null,
      error: {
        code: 'missing_oracle',
        clauseId,
        line,
        message: `Clause "${clauseId}" has no oracle. A normative clause must bind one of: ${ORACLE_KINDS.join(', ')}.`,
      },
    }
  }
  const colon = value.indexOf(':')
  const kind = colon === -1 ? value : value.slice(0, colon)
  const ref = colon === -1 ? null : value.slice(colon + 1)
  if (!isOracleKind(kind)) {
    return {
      oracle: null,
      error: {
        code: 'invalid_oracle_kind',
        clauseId,
        line,
        message: `Clause "${clauseId}" oracle kind "${kind}" is not one of: ${ORACLE_KINDS.join(', ')}.`,
      },
    }
  }
  return { oracle: { kind, ref: ref || null } }
}

const parseRefs = (
  value: string | undefined,
  line: number,
  clauseId: string
): { refs: ClauseRef[]; errors: ClauseParseError[] } => {
  const refs: ClauseRef[] = []
  const errors: ClauseParseError[] = []
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const hash = trimmed.lastIndexOf('#')
    const path = hash === -1 ? '' : trimmed.slice(0, hash)
    const refId = hash === -1 ? '' : trimmed.slice(hash + 1)
    if (!path || !/^C\d+$/.test(refId)) {
      errors.push({
        code: 'malformed_ref',
        clauseId,
        line,
        message: `Clause "${clauseId}" ref "${trimmed}" is not "<path>#C<n>".`,
      })
      continue
    }
    refs.push({ path, clauseId: refId })
  }
  return { refs, errors }
}

export const parseClauseFile = (content: string): ParsedClauseFile => {
  const lines = content.split(/\r?\n/)
  const clauses: ParsedClause[] = []
  const errors: ClauseParseError[] = []
  const seenIds = new Set<string>()
  let seq = 0

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (rawLine === undefined) continue
    const match = rawLine.match(CLAUSE_LINE)
    if (!match) continue

    const [, hashes = '#', clauseId = '', rest = ''] = match

    const anchorMatch = rest.match(ANCHOR)
    let fields: Record<string, string> = {}
    if (anchorMatch?.[1] !== undefined) {
      const parsed = parseAnchorFields(anchorMatch[1])
      fields = parsed.fields
      for (const issue of parsed.issues) errors.push(toAnchorError(issue, i, clauseId))
    }
    const title = rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim()

    const { oracle, error: oracleError } = parseOracle(fields.oracle, i, clauseId)
    if (oracleError) errors.push(oracleError)

    let risk: 'low' | 'high' = 'low'
    if (fields.risk !== undefined) {
      if (fields.risk === 'low' || fields.risk === 'high') {
        risk = fields.risk
      } else {
        errors.push({
          code: 'invalid_risk',
          clauseId,
          line: i,
          message: `Clause "${clauseId}" risk "${fields.risk}" is not "low" or "high".`,
        })
      }
    }

    const { refs, errors: refErrors } = parseRefs(fields.refs, i, clauseId)
    errors.push(...refErrors)

    // Body = lines until the next heading (any level) or EOF.
    const bodyLines: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const probe = lines[j]
      if (probe === undefined || ANY_HEADING.test(probe)) break
      bodyLines.push(probe)
    }
    const body = bodyLines.join('\n').trim() || null

    if (seenIds.has(clauseId)) {
      errors.push({
        code: 'duplicate_clause_id',
        clauseId,
        line: i,
        message: `Clause id "${clauseId}" is declared more than once.`,
      })
    }
    seenIds.add(clauseId)

    clauses.push({
      clauseId,
      seq: ++seq,
      title,
      level: hashes.length,
      oracle,
      risk,
      refs,
      body,
      line: i,
    })
  }

  return { clauses, errors }
}

const toAnchorError = (
  issue: AnchorParseIssue,
  line: number,
  clauseId: string
): ClauseParseError => ({
  code: 'malformed_anchor',
  clauseId,
  line,
  message: `Clause "${clauseId}": ${issue.message}`,
})
