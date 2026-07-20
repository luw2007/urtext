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
  filePath?: string
  lineStart?: number
  lineEnd?: number
}

export interface StatusReport {
  schema: 'urtext.status/1'
  head: string | null
  items: StatusItem[]
  counts: { agent: number; human: number; autoPass: number }
  wip: { limit: number; exceeded: boolean }
}

/** Provisional default — recalibrate from real queue data (plan v2 R5). */
export const DEFAULT_WIP_LIMIT = 10

const NEXT_HINT: Record<StatusReason, string> = {
  missing_evidence: 'run `urtext verify`',
  evidence_failing: 'fix the implementation, then `urtext verify`',
  stale: 'upstream changed — re-run `urtext verify`',
  unaudited: '`urtext audit --export` → different-preset audit → `urtext audit --import`',
  audit_disagreement: 'resolve the meta-audit disagreement (D3): fix the oracle or re-audit',
  review_rejected: 'address the rejection, then `urtext brief` + `urtext review --approve --brief <hash>`',
  worktree_dirty: 'uncommitted edits ride a clean-tree approval — commit (HEAD moves, re-review) or revert',
  review_needed: '`urtext brief <key>`, review the code, then `urtext review <key> --approve|--reject --brief <hash>`',
  manual_failed: 'address the recorded failure, then re-`urtext decide`',
  manual_undecided: '`urtext brief <key>`, then `urtext decide <key> --pass|--fail`',
  unmapped: '`urtext map <spec>#<clause> <range>` | `urtext ack <range> <reason>` | write back to spec',
}

/** Mirror of the gate's escalation logic as typed reason codes. */
const clauseReasons = (decision: ClauseDecision, dirtyWorktree: boolean): Set<StatusReason> => {
  const reasons = new Set<StatusReason>()
  const isManual = decision.decisionVerdict !== 'n/a'
  if (decision.evidenceVerdict === 'missing') reasons.add('missing_evidence')
  else if (decision.evidenceVerdict === 'fail') reasons.add('evidence_failing')
  else if (decision.evidenceVerdict === 'pending' && isManual) {
    if (decision.decisionVerdict === 'fail') reasons.add('manual_failed')
    else if (decision.decisionVerdict !== 'pass') reasons.add('manual_undecided')
  }
  if (decision.stale) reasons.add('stale')
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

const clauseItem = (decision: ClauseDecision, dirtyWorktree: boolean): StatusItem | null => {
  const present = clauseReasons(decision, dirtyWorktree)
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
  }
}

const byRiskThenKey = (a: StatusItem, b: StatusItem): number => {
  const riskRank = (item: StatusItem): number => (item.risk === 'high' ? 0 : 1)
  return riskRank(a) - riskRank(b) || a.key.localeCompare(b.key)
}

export interface StatusInput {
  head: string | null
  /** Working-tree hunks with no mapping/ack/spec write-back (dwarf.detectUnmapped). */
  unmapped: DiffHunk[]
  /** Uncommitted worktree state (review.worktreeDirty) — re-queues approved high-risk clauses. */
  dirtyWorktree?: boolean
  wipLimit?: number
}

export const buildStatus = (db: Database, input: StatusInput): StatusReport => {
  const dirty = input.dirtyWorktree ?? false
  const report = adjudicate(db, input.unmapped.length, input.head ?? undefined, {
    dirtyWorktree: dirty,
  })

  const clauseItems = report.decisions
    .map((decision) => clauseItem(decision, dirty))
    .filter((item): item is StatusItem => item !== null)
  const unmappedItems: StatusItem[] = input.unmapped.map((hunk) => ({
    key: `${hunk.filePath}:${hunk.lineStart}-${hunk.lineEnd}`,
    kind: 'unmapped',
    lane: 'human',
    primary: 'unmapped',
    reasons: ['unmapped'],
    next: NEXT_HINT.unmapped,
    filePath: hunk.filePath,
    lineStart: hunk.lineStart,
    lineEnd: hunk.lineEnd,
  }))

  // Human queue first (unmapped blocks the merge outright, then by risk),
  // agent lane after — the operator reads top-down.
  const human = [
    ...unmappedItems,
    ...clauseItems.filter((item) => item.lane === 'human').sort(byRiskThenKey),
  ]
  const agent = clauseItems.filter((item) => item.lane === 'agent').sort(byRiskThenKey)

  const limit = input.wipLimit ?? DEFAULT_WIP_LIMIT
  return {
    schema: 'urtext.status/1',
    head: input.head,
    items: [...human, ...agent],
    counts: {
      agent: agent.length,
      human: human.length,
      autoPass: report.decisions.length - clauseItems.length,
    },
    wip: { limit, exceeded: human.length > limit },
  }
}
