/**
 * Operator status queue (operator-flow plan P1) — ONE entry point answering
 * "what needs attention right now", instead of the human mentally merging
 * check/verify/gate/decisions output.
 *
 * Two lanes, split by who can act (VISION P4 attention contraction):
 *   agent  — remediable without judgment: missing/failing evidence, stale,
 *            unaudited. These are prerequisites; routing them to a human
 *            would be assembly work, not adjudication.
 *   human  — judgment items whose prerequisites are met: audit disagreement,
 *            high-risk review, manual decision, unmapped changes.
 *
 * Item-keyed: a clause appears ONCE with a primary blocker plus secondary
 * reasons (gate's six reason categories are not mutually exclusive). A clause
 * with any agent-lane reason stays in the agent lane — the human sees it only
 * after prerequisites resolve.
 *
 * Pure over the registry: the caller supplies head and the real-diff unmapped
 * hunks (same contract as `adjudicate`).
 */

import type { Database } from 'better-sqlite3'

import type { DiffHunk } from './dwarf.js'
import { adjudicate, type ClauseDecision } from './gate.js'
import { uncoveredRequirements, type RequirementCoverage } from './linker.js'

export type StatusLane = 'agent' | 'human'

export type StatusReason =
  | 'missing_evidence'
  | 'evidence_failing'
  | 'stale'
  | 'unaudited'
  | 'audit_disagreement'
  | 'review_rejected'
  | 'worktree_dirty'
  | 'review_needed'
  | 'manual_failed'
  | 'manual_undecided'
  | 'unmapped'

const AGENT_ORDER: StatusReason[] = ['missing_evidence', 'evidence_failing', 'stale', 'unaudited']
const HUMAN_ORDER: StatusReason[] = [
  'audit_disagreement',
  'review_rejected',
  'worktree_dirty',
  'review_needed',
  'manual_failed',
  'manual_undecided',
]

export interface StatusItem {
  /** `<spec-path>#C<n>` for clauses, `<file>:<start>-<end>` for unmapped hunks. */
  key: string
  kind: 'clause' | 'unmapped'
  lane: StatusLane
  /** First blocker in precedence order — what to resolve next. */
  primary: StatusReason
  reasons: StatusReason[]
  /** Suggested next action (display hint, not a contract). */
  next: string
  specPath?: string
  clauseId?: string
  title?: string
  risk?: 'low' | 'high'
  /** Declared interface surfaces this unmapped hunk touches (L2), sorted I-IDs. */
  matchedInterfaces?: string[]
  /** Origin key for a stale stamp; absent for fresh and legacy rows. */
  invalidationSource?: string
  filePath?: string
  lineStart?: number
  lineEnd?: number
}

export interface StatusReport {
  schema: 'urtext.status/1'
  head: string | null
  items: StatusItem[]
  counts: { agent: number; human: number; uncovered: number; autoPass: number }
  wip: { limit: number; exceeded: boolean }
  /** Live requirements with zero uniquely resolved live clause bindings. */
  uncoveredRequirements: RequirementCoverage[]
}

export interface EvidenceStalenessProjection {
  stale: boolean
  /** Origin key for a stale stamp; null for legacy unattributed rows. */
  invalidationSource: string | null
}

/**
 * Display-only staleness for each clause's latest evidence row, regardless of
 * revision. The projection deliberately exposes no verdict: callers must keep
 * using adjudicate's current-revision verdict and may only add stale context.
 */
export const projectEvidenceStaleness = (
  db: Database
): Map<string, EvidenceStalenessProjection> => {
  const rows = db
    .prepare(
      `SELECT e.spec_path, e.clause_id, e.invalidated_at, e.invalidation_source
       FROM evidence e
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM evidence GROUP BY spec_path, clause_id
       ) latest ON latest.id = e.id`
    )
    .all() as {
      spec_path: string
      clause_id: string
      invalidated_at: number | null
      invalidation_source: string | null
    }[]
  return new Map(
    rows.map((row) => [
      `${row.spec_path}#${row.clause_id}`,
      {
        stale: row.invalidated_at !== null,
        invalidationSource: row.invalidated_at === null ? null : row.invalidation_source,
      },
    ])
  )
}

/** Provisional default — recalibrate from real queue data (plan v2 R5). */
export const DEFAULT_WIP_LIMIT = 10

const NEXT_HINT: Record<StatusReason, string> = {
  missing_evidence: 'run `urtext verify`',
  evidence_failing: 'fix the implementation, then `urtext verify`',
  stale: 'upstream changed — re-run `urtext verify`',
  unaudited: '`urtext audit --run <claude|codex|omp>` | `urtext audit --export` → different-preset audit → `urtext audit --import`',
  audit_disagreement: 'resolve the meta-audit disagreement (D3): fix the oracle or re-audit',
  review_rejected: 'address the rejection, then `urtext brief` + `urtext review --approve --brief <hash>`',
  worktree_dirty: 'uncommitted edits ride a clean-tree approval — commit (HEAD moves, re-review) or revert',
  review_needed: '`urtext brief <key>`, review the code, then `urtext review <key> --approve|--reject --brief <hash>`',
  manual_failed: 'address the recorded failure, then re-`urtext decide`',
  manual_undecided: '`urtext brief <key>`, then `urtext decide <key> --pass|--fail`',
  unmapped: '`urtext map <spec>#<clause> <range>` | `urtext ack <range> <reason>` | write back to spec',
}

/** Mirror of the gate's escalation logic as typed reason codes. */
const clauseReasons = (
  decision: ClauseDecision,
  dirtyWorktree: boolean,
  stale: boolean
): Set<StatusReason> => {
  const reasons = new Set<StatusReason>()
  const isManual = decision.decisionVerdict !== 'n/a'
  if (decision.evidenceVerdict === 'missing') reasons.add('missing_evidence')
  else if (decision.evidenceVerdict === 'fail') reasons.add('evidence_failing')
  else if (decision.evidenceVerdict === 'pending' && isManual) {
    if (decision.decisionVerdict === 'fail') reasons.add('manual_failed')
    else if (decision.decisionVerdict !== 'pass') reasons.add('manual_undecided')
  }
  if (stale) reasons.add('stale')
  if (!isManual) {
    if (decision.auditVerdict === 'disagree') reasons.add('audit_disagreement')
    else if (decision.auditVerdict === 'unaudited') reasons.add('unaudited')
  }
  if (decision.risk === 'high') {
    if (decision.reviewStatus === 'rejected') reasons.add('review_rejected')
    else if (decision.reviewStatus === 'none') reasons.add('review_needed')
    else if (decision.reviewStatus === 'approved' && dirtyWorktree) reasons.add('worktree_dirty')
  }
  return reasons
}

const clauseItem = (
  decision: ClauseDecision,
  dirtyWorktree: boolean,
  staleness: EvidenceStalenessProjection | undefined
): StatusItem | null => {
  const stale = decision.stale || staleness?.stale === true
  const invalidationSource = decision.invalidationSource ?? staleness?.invalidationSource ?? null
  const present = clauseReasons(decision, dirtyWorktree, stale)
  if (present.size === 0) return null
  const ordered = [...AGENT_ORDER, ...HUMAN_ORDER].filter((reason) => present.has(reason))
  const lane: StatusLane = AGENT_ORDER.some((reason) => present.has(reason)) ? 'agent' : 'human'
  const primary = ordered[0]!
  return {
    key: `${decision.specPath}#${decision.clauseId}`,
    kind: 'clause',
    lane,
    primary,
    reasons: ordered,
    next: NEXT_HINT[primary],
    specPath: decision.specPath,
    clauseId: decision.clauseId,
    title: decision.title,
    risk: decision.risk,
    ...(stale && invalidationSource !== null
      ? { invalidationSource }
      : {}),
  }
}

const byRiskThenKey = (a: StatusItem, b: StatusItem): number => {
  const riskRank = (item: StatusItem): number => (item.risk === 'high' ? 0 : 1)
  return riskRank(a) - riskRank(b) || a.key.localeCompare(b.key)
}

export interface StatusInput {
  head: string | null
  /** Working-tree hunks with no mapping/ack/spec write-back (dwarf.detectUnmapped), optionally classified against declared interface surfaces (contract-classify). */
  unmapped: (DiffHunk & { matchedInterfaces?: string[] })[]
  /** I-ID → interface title, for display hints on touched surfaces. */
  interfaceTitles?: Record<string, string>
  /** Uncommitted worktree state (review.worktreeDirty) — re-queues approved high-risk clauses. */
  dirtyWorktree?: boolean
  wipLimit?: number
}

export const buildStatus = (db: Database, input: StatusInput): StatusReport => {
  const dirty = input.dirtyWorktree ?? false
  const touchingCount = input.unmapped.filter(
    (hunk) => (hunk.matchedInterfaces?.length ?? 0) > 0
  ).length
  const report = adjudicate(db, input.unmapped.length, input.head ?? undefined, {
    dirtyWorktree: dirty,
    interfaceSurfaceUnmappedCount: touchingCount,
  })
  const staleness = projectEvidenceStaleness(db)

  const clauseItems = report.decisions
    .map((decision) => clauseItem(
      decision,
      dirty,
      staleness.get(`${decision.specPath}#${decision.clauseId}`)
    ))
    .filter((item): item is StatusItem => item !== null)
  const unmappedItems: StatusItem[] = input.unmapped.map((hunk) => {
    const touched = hunk.matchedInterfaces ?? []
    const touches = touched
      .map((id) => {
        const title = input.interfaceTitles?.[id]
        return title === undefined ? id : `${id} (${title})`
      })
      .join(', ')
    return {
      key: `${hunk.filePath}:${hunk.lineStart}-${hunk.lineEnd}`,
      kind: 'unmapped',
      lane: 'human',
      primary: 'unmapped',
      reasons: ['unmapped'],
      next: touched.length > 0 ? `touches ${touches} — ${NEXT_HINT.unmapped}` : NEXT_HINT.unmapped,
      filePath: hunk.filePath,
      lineStart: hunk.lineStart,
      lineEnd: hunk.lineEnd,
      // Interface-touch only upgrades risk, never downgrades (sol review #5).
      ...(touched.length > 0 ? { risk: 'high' as const, matchedInterfaces: touched } : {}),
    }
  })

  // Human queue first (unmapped blocks the merge outright, then by risk),
  // agent lane after — the operator reads top-down.
  const human = [
    ...unmappedItems.sort(byRiskThenKey),
    ...clauseItems.filter((item) => item.lane === 'human').sort(byRiskThenKey),
  ]
  const agent = clauseItems.filter((item) => item.lane === 'agent').sort(byRiskThenKey)

  const limit = input.wipLimit ?? DEFAULT_WIP_LIMIT
  const uncovered = uncoveredRequirements(db)
  return {
    schema: 'urtext.status/1',
    head: input.head,
    items: [...human, ...agent],
    counts: {
      agent: agent.length,
      human: human.length,
      uncovered: uncovered.length,
      autoPass: report.decisions.length - clauseItems.length,
    },
    wip: { limit, exceeded: human.length > limit },
    uncoveredRequirements: uncovered,
  }
}
