/**
 * Operator console core (pure logic) — the model and rendering behind
 * `urtext ui`. v1 was a manual-decision panel; the operator-flow plan (v3)
 * upgrades it to the console: the two-lane status queue, inline brief access,
 * and decide buttons that quote the brief-hash.
 *
 * Truth sources are unchanged (C104, P2): reads go through `buildStatus`/
 * `adjudicate`, writes through `recordDecision` — the same guarded domain path
 * as the CLI, so a high-risk manual clause cannot be passed from the browser
 * without the current brief-hash (C018; the guard lives in decision.ts, not
 * here). High-risk CODE review is also available from the browser: the /brief
 * page shows the mapped code and, when the clause is review-ready, approve/reject
 * buttons that post to the SAME guarded `recordReview` path (P5 preconditions —
 * high-risk only, clean worktree, current brief-hash, HEAD binding — live in
 * review.ts, not here, so the browser cannot bypass them).
 */
import type { Database } from 'better-sqlite3'

import { runAgentText, runAuditAgentAsync, type AgentTransportDeps, type AuditorId } from './audit-runner.js'
import { coverage, exportRequest, importVerdicts } from './audit.js'
import { buildBrief, renderBriefText, type Brief, type BriefHistoryLine, type ClauseTarget } from './brief.js'
import { detectUnmapped, type DiffHunk } from './dwarf.js'
import { adjudicate } from './gate.js'
import { buildStatus, type StatusReport } from './status.js'
import { currentHead, listDecisions, recordDecision } from './decision.js'
import { listReviews, recordReview, worktreeDirty } from './review.js'
import type {
  ClauseNavigation,
  ImpactDependent,
  RequirementBindingView,
  ReviewFacts,
  SpecImpactView,
} from './ui/contracts.js'

export type {
  ClauseNavigation,
  ImpactDependent,
  RequirementBindingView,
  ReviewFacts,
  SpecImpactView,
} from './ui/contracts.js'
export interface UiClause {
  specPath: string
  clauseId: string
  title: string
  risk: 'low' | 'high'
  /** Human decision at the current HEAD for a manual clause. */
  decisionVerdict: 'pass' | 'fail' | 'none' | 'n/a'
  evidenceVerdict: 'pass' | 'fail' | 'pending' | 'missing'
  stale: boolean
  /** A manual clause still awaiting a human decision — render pass/fail buttons. */
  actionable: boolean
}

export interface UiSnapshot {
  head: string | null
  /** Uncommitted worktree state — re-queues approved high-risk clauses. */
  dirty: boolean
  /** The operator queue (same builder as `urtext status`). */
  status: StatusReport
  clauses: UiClause[]
  /** Manual clauses decided at HEAD / total manual clauses. */
  decided: number
  totalManual: number
  /** Workspace-level hunks that have no mapping, acknowledgement, or spec write-back. */
  unmapped: DiffHunk[]
  /** Detection failure is distinct from an empty result; render it fail-closed. */
  unmappedError: string | null
}

/** Build the console model: status lanes + the manual-decision view. */
export const buildUiSnapshot = (db: Database, root: string): UiSnapshot => {
  const head = currentHead(root)
  const dirty = worktreeDirty(root) ?? false
  const unmappedReport = detectUnmapped(db, root)
  const unmapped = 'error' in unmappedReport ? [] : unmappedReport.unmapped
  const unmappedError = 'error' in unmappedReport ? unmappedReport.error : null
  const status = buildStatus(db, { head, unmapped, dirtyWorktree: dirty })
  const report = adjudicate(db, unmapped.length, head ?? undefined, { dirtyWorktree: dirty })
  const clauses: UiClause[] = report.decisions.map((d) => {
    const isManual = d.decisionVerdict !== 'n/a'
    return {
      specPath: d.specPath,
      clauseId: d.clauseId,
      title: d.title,
      risk: d.risk,
      evidenceVerdict: d.evidenceVerdict,
      stale: d.stale,
      decisionVerdict: d.decisionVerdict,
      actionable: isManual && d.decisionVerdict === 'none',
    }
  })
  const manual = clauses.filter((c) => c.decisionVerdict !== 'n/a')
  return {
    head,
    dirty,
    status,
    clauses,
    unmapped,
    unmappedError,
    decided: manual.filter((c) => c.decisionVerdict === 'pass' || c.decisionVerdict === 'fail').length,
    totalManual: manual.length,
  }
}

/** Review + decision ledger lines for one clause, newest first (brief display). */
export const briefHistory = (db: Database, target: ClauseTarget): BriefHistoryLine[] =>
  [
    ...listReviews(db)
      .filter((r) => r.specPath === target.specPath && r.clauseId === target.clauseId)
      .map((r) => ({
        when: r.createdAt,
        what: `review ${r.decision} @ ${r.commitSha.slice(0, 7)} by ${r.reviewer}`,
        note: r.note,
      })),
    ...listDecisions(db)
      .filter((d) => d.specPath === target.specPath && d.clauseId === target.clauseId)
      .map((d) => ({
        when: d.createdAt,
        what: `decide ${d.verdict} @ ${d.commitSha.slice(0, 7)} by ${d.decider}`,
        note: d.note,
      })),
  ].sort((a, b) => b.when - a.when)

interface StoredClauseRequirement {
  path: string | null
  reqId: string
}

const featureOf = (specPath: string): string | null =>
  specPath.match(/^specs\/([^/]+)\//)?.[1] ?? null

/** Resolve the target clause's stored `reqs` JSON in declaration order.
 * Requirement liveness is checked with a req-id-scoped query, not liveGraph. */
const resolveClauseRequirementBindings = (
  db: Database,
  target: ClauseTarget
): RequirementBindingView[] => {
  const clause = db
    .prepare(
      `SELECT c.reqs
       FROM clauses c
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = c.spec_path AND latest.revision = c.revision
       JOIN revisions r ON r.spec_path = c.spec_path AND r.revision = c.revision
       WHERE c.spec_path = ? AND c.clause_id = ? AND r.status != 'tombstoned'`
    )
    .get(target.specPath, target.clauseId) as { reqs: string } | undefined
  if (clause === undefined) return []

  const declared = JSON.parse(clause.reqs) as StoredClauseRequirement[]
  const requirementStmt = db.prepare(
    `SELECT q.spec_path, q.req_id, q.title
     FROM requirements q
     JOIN (
       SELECT spec_path, MAX(revision) AS revision
       FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
     ) latest ON latest.spec_path = q.spec_path AND latest.revision = q.revision
     JOIN revisions r ON r.spec_path = q.spec_path AND r.revision = q.revision
     WHERE q.req_id = ? AND r.status != 'tombstoned'
     ORDER BY q.spec_path, q.req_id`
  )
  const sourceFeature = featureOf(target.specPath)
  return declared.map((binding) => {
    const rawTarget = binding.path === null ? binding.reqId : `${binding.path}#${binding.reqId}`
    const rows = requirementStmt.all(binding.reqId) as {
      spec_path: string
      req_id: string
      title: string
    }[]
    const candidates = rows
      .filter((row) =>
        binding.path === null
          ? sourceFeature !== null && featureOf(row.spec_path) === sourceFeature
          : row.spec_path === binding.path
      )
      .map((row) => ({ specPath: row.spec_path, reqId: row.req_id, title: row.title }))
    const resolved = candidates.length === 1 ? candidates[0] : undefined
    if (resolved !== undefined) return { state: 'resolved', rawTarget, target: resolved }
    if (candidates.length === 0) return { state: 'dangling', rawTarget }
    return { state: 'ambiguous', rawTarget, candidates }
  })
}

export const buildSpecImpactView = (
  brief: Brief,
  dependents: ImpactDependent[] = [],
  navigation: ClauseNavigation = { previous: null, next: null },
  requirementBindings: RequirementBindingView[] = []
): SpecImpactView => ({
  schema: 'urtext.spec-impact/1',
  head: brief.manifest.head,
  target: { specPath: brief.manifest.specPath, clauseId: brief.manifest.clauseId },
  oracleKind: brief.manifest.oracleKind,
  oracleRef: brief.manifest.oracleRef,
  risk: brief.manifest.risk,
  stale: brief.manifest.stale,
  hasEvidence: brief.manifest.evidence !== null,
  requirementBindings,
  mappings: brief.manifest.mappings,
  impact: brief.impact,
  dependents,
  navigation,
})


export interface BriefApiResult {
  status: number
  body:
    | { ok: true; briefHash: string; text: string; risk: 'low' | 'high'; reviewable: boolean; facts: ReviewFacts; view: SpecImpactView }
    | { error: string; requirementBindings: RequirementBindingView[] }
}

/** Build one clause's brief for the console (JSON api + the /brief page). */
export const handleBrief = (db: Database, root: string, spec: unknown, clause: unknown): BriefApiResult => {
  if (typeof spec !== 'string' || typeof clause !== 'string' || !/^C\d+$/.test(clause)) {
    return {
      status: 400,
      body: { error: 'need ?spec=<spec-path>&clause=C<n>', requirementBindings: [] },
    }
  }
  const target = { specPath: spec, clauseId: clause }
  const outcome = buildBrief(db, root, target)
  if (outcome.kind === 'refused') {
    const requirementBindings =
      outcome.code === 'unknown_clause' ? [] : resolveClauseRequirementBindings(db, target)
    return {
      status: outcome.code === 'unknown_clause' ? 404 : 409,
      body: { error: `[${outcome.code}] ${outcome.message}`, requirementBindings },
    }
  }
  const manifest = outcome.brief.manifest
  const reviewable =
    manifest.risk === 'high' &&
    manifest.evidence?.verdict === 'pass' &&
    manifest.auditVerdict === 'agree' &&
    !manifest.stale
  const files = [...new Set(manifest.mappings.map((mapping) => mapping.filePath))]
  const decisions = adjudicate(db, 0, manifest.head ?? undefined).decisions
  const decisionByKey = new Map(decisions.map((decision) => [`${decision.specPath}#${decision.clauseId}`, decision]))
  const dependents: ImpactDependent[] = outcome.brief.impact.affectedClauses.map((dependent) => {
    const decision = decisionByKey.get(`${dependent.specPath}#${dependent.clauseId}`)
    return {
      ...dependent,
      title: decision?.title ?? '',
      stale: decision?.stale ?? false,
      evidenceVerdict: decision?.evidenceVerdict ?? 'missing',
    }
  })
  const sameSpec = decisions.filter((decision) => decision.specPath === manifest.specPath)
  const currentIndex = sameSpec.findIndex((decision) => decision.clauseId === manifest.clauseId)
  const toTarget = (index: number): ClauseTarget | null => {
    const decision = sameSpec[index]
    return decision ? { specPath: decision.specPath, clauseId: decision.clauseId } : null
  }
  const navigation: ClauseNavigation = {
    previous: toTarget(currentIndex - 1),
    next: toTarget(currentIndex + 1),
  }
  return {
    status: 200,
    body: {
      ok: true,
      briefHash: outcome.brief.briefHash,
      text: renderBriefText(outcome.brief, briefHistory(db, target)),
      risk: manifest.risk,
      reviewable,
      view: buildSpecImpactView(
        outcome.brief,
        dependents,
        navigation,
        resolveClauseRequirementBindings(db, target)
      ),
      facts: {
        title: `${manifest.specPath}#${manifest.clauseId} ${manifest.title}`,
        files,
        dependents: dependents.length,
      },
    },
  }
}

export interface ReviewApiResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one high-risk code review from the /brief page. Reuses recordReview's
 * fail-closed guards (unsafe lane P5): high-risk only, clean worktree, current
 * brief-hash, HEAD binding. Approving requires a one-sentence reason — the same
 * anti-rubber-stamp rule as manual pass; rejecting is conservative. */
export const handleReview = (db: Database, root: string, input: unknown, reviewer: string): ReviewApiResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const key = 'key' in input ? input.key : undefined
  const decision = 'decision' in input ? input.decision : undefined
  const briefHash = 'briefHash' in input ? input.briefHash : undefined
  const note = 'note' in input ? input.note : undefined
  if (typeof key !== 'string' || (decision !== 'approve' && decision !== 'reject'))
    return { status: 400, body: { error: 'need { key, decision: approve|reject }' } }
  if (briefHash !== undefined && typeof briefHash !== 'string')
    return { status: 400, body: { error: 'briefHash must be a string' } }
  if (note !== undefined && typeof note !== 'string')
    return { status: 400, body: { error: 'note must be a string' } }
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (decision === 'approve' && trimmedNote === '')
    return { status: 400, body: { error: 'a one-sentence reason (note) is required to approve' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const outcome = recordReview(
    db,
    {
      specPath: key.slice(0, hash),
      clauseId: key.slice(hash + 1),
      decision,
      reviewer,
      ...(trimmedNote ? { note: trimmedNote } : {}),
      ...(briefHash !== undefined ? { briefHash } : {}),
    },
    root,
    Date.now()
  )
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}

export interface ExplainApiResult {
  status: number
  body: { ok: true; text: string } | { error: string }
}

const parseAuditorId = (value: unknown): AuditorId | null =>
  value === 'claude' || value === 'codex' || value === 'traex' || value === 'omp' ? value : null

/** On-demand, per-clause explanation of what approving vs rejecting THIS clause
 * means — generated live by a selected headless client from the clause's own
 * brief (title, body, mapped code, evidence, impact), not a hard-coded template.
 * Read-only: no ledger write, no tools; the model only explains consequences. */
export const handleExplain = async (db: Database, root: string, input: unknown, deps: AgentTransportDeps = {}): Promise<ExplainApiResult> => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const key = 'key' in input ? input.key : undefined
  const auditor = parseAuditorId('auditor' in input ? input.auditor : undefined)
  const model = 'model' in input ? input.model : undefined
  if (typeof key !== 'string' || key.lastIndexOf('#') <= 0 || auditor === null)
    return { status: 400, body: { error: 'need { key, auditor: claude|codex|traex|omp }' } }
  if (model !== undefined && typeof model !== 'string')
    return { status: 400, body: { error: 'model must be a string' } }
  const hash = key.lastIndexOf('#')
  const outcome = buildBrief(db, root, { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) })
  if (outcome.kind === 'refused') return { status: 409, body: { error: outcome.message } }
  const prompt = [
    '你是 Urtext 的资深审查助手。下面是一个高风险条款的完整裁决简报（条文、映射代码、证据、影响闭包）。',
    '用中文，基于这个条款的具体内容，向人类审查者说明：',
    '1. 如果批准（approve）这条，对系统有什么实际影响——结合该条款真实约束和它保护的代码路径，举一个具体、可能发生的场景；',
    '2. 如果拒绝（reject）这条，会怎样，以及在什么情况下应该拒绝——同样给一个具体例子；',
    '3. 一句话给出你的倾向和理由。',
    '不要泛泛而谈或复述通用流程；紧扣本条款的语义与代码。不要执行任何命令或修改文件，只解释。',
    '',
    renderBriefText(outcome.brief, briefHistory(db, { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) })),
  ].join('\n')
  const result = await runAgentText(prompt, { id: auditor, ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}) }, deps.spawnAsync)
  return result.kind === 'completed' && result.text !== undefined
    ? { status: 200, body: { ok: true, text: result.text } }
    : { status: 422, body: { error: result.message ?? 'agent failed' } }
}

export interface AuditRunResult {
  status: number
  body: { ok: true; message: string } | { error: string }
}

export const handleAuditRun = async (db: Database, input: unknown, deps: AgentTransportDeps = {}): Promise<AuditRunResult> => {
  if (typeof input !== 'object' || input === null || !('auditor' in input)) {
    return { status: 400, body: { error: 'need auditor: claude, codex, traex, or omp' } }
  }
  const auditor = input.auditor
  const model = 'model' in input ? input.model : undefined
  const profile = 'profile' in input ? input.profile : undefined
  if ((auditor !== 'claude' && auditor !== 'codex' && auditor !== 'traex' && auditor !== 'omp') ||
      (model !== undefined && typeof model !== 'string') || (profile !== undefined && typeof profile !== 'string') ||
      (auditor === 'claude' && profile !== undefined && profile !== '')) {
    return { status: 400, body: { error: 'invalid auditor, model, or profile' } }
  }
  const result = await runAuditAgentAsync(exportRequest(db), {
    id: auditor,
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(typeof profile === 'string' && profile.trim() ? { profile: profile.trim() } : {}),
  }, deps.spawnAsync)
  if (result.kind === 'rejected') return { status: 422, body: { error: result.message ?? 'audit runner rejected' } }
  if (result.verdicts === undefined || result.verdicts.length === 0) {
    return { status: 200, body: { ok: true, message: 'No decided, current evidence to audit.' } }
  }
  const outcome = importVerdicts(db, result.verdicts, Date.now())
  if (outcome.kind === 'rejected') return { status: 422, body: { error: outcome.message } }
  const report = coverage(db)
  return {
    status: 200,
    body: {
      ok: true,
      message: report.counts.disagree > 0
        ? `imported ${outcome.count} verdict(s); ${report.counts.disagree} disagreement(s) moved to Your queue.`
        : `imported ${outcome.count} verdict(s)`,
    },
  }
}


export interface DecideResult {
  status: number
  body: { ok: true } | { error: string }
}

/** Apply one adjudication from the UI. Reuses `recordDecision` guards (P2:
 * non-manual clauses rejected; verdict bound to HEAD; a high-risk manual pass
 * additionally requires the current brief-hash — C018). The ui path further
 * requires a one-sentence reason to PASS — one-click approval is exactly
 * where rubber-stamping lives; `fail` is conservative and may omit it. The
 * CLI keeps `note` optional (typing the command is its own deliberation). */
export const handleDecide = (
  db: Database,
  root: string,
  input: unknown,
  decider: string
): DecideResult => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const { key, verdict, briefHash, note } = input as {
    key?: unknown
    verdict?: unknown
    briefHash?: unknown
    note?: unknown
  }
  if (typeof key !== 'string' || (verdict !== 'pass' && verdict !== 'fail'))
    return { status: 400, body: { error: 'need { key, verdict: pass|fail }' } }
  if (briefHash !== undefined && typeof briefHash !== 'string')
    return { status: 400, body: { error: 'briefHash must be a string' } }
  if (note !== undefined && typeof note !== 'string')
    return { status: 400, body: { error: 'note must be a string' } }
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (verdict === 'pass' && trimmedNote === '')
    return { status: 400, body: { error: 'a one-sentence reason (note) is required to pass' } }
  const hash = key.lastIndexOf('#')
  if (hash <= 0) return { status: 400, body: { error: 'bad clause key' } }
  const specPath = key.slice(0, hash)
  const clauseId = key.slice(hash + 1)
  const outcome = recordDecision(
    db,
    {
      specPath,
      clauseId,
      verdict,
      decider,
      ...(trimmedNote ? { note: trimmedNote } : {}),
      ...(briefHash !== undefined ? { briefHash } : {}),
    },
    root,
    Date.now()
  )
  return outcome.kind === 'recorded'
    ? { status: 200, body: { ok: true } }
    : { status: 400, body: { error: outcome.message } }
}
