/**
 * Linker — resolves cross-file clause refs over the latest live revisions,
 * fails closed on `unknown_ref`, and propagates staleness: when a clause's
 * normative text changes, every clause that (transitively) refs it has its
 * recorded evidence invalidated and must re-verify (ROADMAP M2).
 *
 * Edge direction: `A refs B` = A depends on B. B changes → A is stale.
 */

import type { Database } from 'better-sqlite3'

import { ensureEvidenceLedger } from './verifier.js'

export interface LinkError {
  code: 'unknown_ref' | 'unknown_req' | 'ambiguous_req'
  /** Clause file declaring the broken ref. */
  specPath: string
  clauseId: string
  line: number
  message: string
  /** Machine-readable unresolved or ambiguous edge target. */
  target?: string
}

export interface ClauseKey {
  specPath: string
  clauseId: string
}

export interface RequirementKey {
  specPath: string
  reqId: string
}

export interface RequirementCoverage {
  specPath: string
  reqId: string
  title: string
}

export interface StaleReport {
  /** Dependents (reverse transitive closure of the changed clauses). */
  staleClauses: ClauseKey[]
  /** Evidence rows stamped `invalidated_at` by this propagation. */
  invalidatedEvidence: number
}

export interface ImpactReport {
  source: ClauseKey
  /** Reverse transitive closure of `source`, BFS order, source excluded. */
  affectedClauses: ClauseKey[]
  /** Tasks citing the source or any affected clause, in their feature units. */
  affectedTasks: { specPath: string; fileId: string; title: string; clauseId: string }[]
}

interface RefEdge {
  spec_path: string
  clause_id: string
  to_spec: string
  to_clause: string
  line: number
}

interface ReqEdge {
  spec_path: string
  clause_id: string
  /** '' = unit-local bare `FR<n>`; otherwise the target spec path. */
  to_spec: string
  to_req: string
  line: number
}

const keyOf = (specPath: string, clauseId: string): string => `${specPath}#${clauseId}`

/** `specs/<feature>/…` → `<feature>`; null outside the specs tree. */
const featureOf = (specPath: string): string | null =>
  specPath.match(/^specs\/([^/]+)\//)?.[1] ?? null

/** Latest non-tombstoned revision per clause file. */
const liveClauseRevisions = (db: Database): { spec_path: string; revision: number }[] =>
  db
    .prepare(
      `SELECT r.spec_path, r.revision
       FROM revisions r
       JOIN (
         SELECT spec_path, MAX(revision) AS revision
         FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
       ) latest ON latest.spec_path = r.spec_path AND latest.revision = r.revision
       WHERE r.status != 'tombstoned'`
    )
    .all() as { spec_path: string; revision: number }[]

interface LiveGraph {
  revisions: { spec_path: string; revision: number }[]
  declared: Set<string>
  edges: RefEdge[]
  declaredReqs: Set<string>
  unitReqs: Map<string, RequirementKey[]>
  reqEdges: ReqEdge[]
}

/** Declared clauses/requirements and outgoing edges of the latest live revisions. */
const liveGraph = (db: Database): LiveGraph => {
  const revisions = liveClauseRevisions(db)
  const declared = new Set<string>()
  const edges: RefEdge[] = []
  const declaredReqs = new Set<string>()
  const unitReqs = new Map<string, RequirementKey[]>()
  const reqEdges: ReqEdge[] = []
  const clauseStmt = db.prepare(
    'SELECT clause_id FROM clauses WHERE spec_path = ? AND revision = ?'
  )
  const refStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_clause, line
     FROM clause_refs WHERE spec_path = ? AND revision = ?`
  )
  const reqStmt = db.prepare(
    'SELECT req_id FROM requirements WHERE spec_path = ? AND revision = ? ORDER BY seq'
  )
  const reqEdgeStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_req, line
     FROM clause_reqs WHERE spec_path = ? AND revision = ?`
  )
  for (const { spec_path, revision } of revisions) {
    for (const row of clauseStmt.all(spec_path, revision) as { clause_id: string }[]) {
      declared.add(keyOf(spec_path, row.clause_id))
    }
    edges.push(...(refStmt.all(spec_path, revision) as RefEdge[]))
    const feature = featureOf(spec_path)
    for (const row of reqStmt.all(spec_path, revision) as { req_id: string }[]) {
      declaredReqs.add(keyOf(spec_path, row.req_id))
      if (feature === null) continue
      const unitKey = keyOf(feature, row.req_id)
      const owners = unitReqs.get(unitKey)
      if (owners) owners.push({ specPath: spec_path, reqId: row.req_id })
      else unitReqs.set(unitKey, [{ specPath: spec_path, reqId: row.req_id }])
    }
    reqEdges.push(...(reqEdgeStmt.all(spec_path, revision) as ReqEdge[]))
  }
  return { revisions, declared, edges, declaredReqs, unitReqs, reqEdges }
}

/** Resolve a req edge against the current live declarations. */
const resolveReq = (graph: LiveGraph, edge: ReqEdge): RequirementKey[] => {
  if (edge.to_spec !== '') {
    return graph.declaredReqs.has(keyOf(edge.to_spec, edge.to_req))
      ? [{ specPath: edge.to_spec, reqId: edge.to_req }]
      : []
  }
  const feature = featureOf(edge.spec_path)
  if (feature === null) return []
  return graph.unitReqs.get(keyOf(feature, edge.to_req)) ?? []
}

/**
 * Workspace-level ref validation (SYNTAX.md: `unknown_ref` is a check-stage
 * error). Runs against the current snapshot on every scan, so a ref dangling
 * because its TARGET moved is caught even when the referring file is
 * unchanged — per-revision status could never express that.
 */
export const linkWorkspace = (db: Database): LinkError[] => {
  const graph = liveGraph(db)
  const errors: LinkError[] = []
  for (const edge of graph.edges) {
    if (graph.declared.has(keyOf(edge.to_spec, edge.to_clause))) continue
    const target = `${edge.to_spec}#${edge.to_clause}`
    errors.push({
      code: 'unknown_ref',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      line: edge.line,
      message: `Clause "${edge.clause_id}" refs "${target}" which does not exist.`,
      target,
    })
  }
  for (const edge of graph.reqEdges) {
    const candidates = resolveReq(graph, edge)
    const target = edge.to_spec === '' ? edge.to_req : `${edge.to_spec}#${edge.to_req}`
    if (candidates.length === 1) continue
    if (candidates.length === 0) {
      errors.push({
        code: 'unknown_req',
        specPath: edge.spec_path,
        clauseId: edge.clause_id,
        line: edge.line,
        message: `Clause "${edge.clause_id}" binds requirement "${target}" which no live spec file declares.`,
        target,
      })
      continue
    }
    errors.push({
      code: 'ambiguous_req',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      line: edge.line,
      message: `Clause "${edge.clause_id}" binds requirement "${target}" which is declared by multiple files: ${candidates.map((candidate) => candidate.specPath).join(', ')}.`,
      target,
    })
  }
  return errors
}

/** Reverse transitive closure (BFS) of `sources` over the live refs graph. */
const reverseClosure = (edges: RefEdge[], sources: ClauseKey[]): ClauseKey[] => {
  const dependents = new Map<string, ClauseKey[]>()
  for (const edge of edges) {
    const target = keyOf(edge.to_spec, edge.to_clause)
    const list = dependents.get(target) ?? []
    list.push({ specPath: edge.spec_path, clauseId: edge.clause_id })
    dependents.set(target, list)
  }

  const visited = new Set(sources.map((s) => keyOf(s.specPath, s.clauseId)))
  const queue = [...sources]
  const closure: ClauseKey[] = []
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    if (current === undefined) continue
    for (const dependent of dependents.get(keyOf(current.specPath, current.clauseId)) ?? []) {
      const key = keyOf(dependent.specPath, dependent.clauseId)
      if (visited.has(key)) continue
      visited.add(key)
      closure.push(dependent)
      queue.push(dependent)
    }
  }
  return closure
}

/**
 * Mark every dependent of `changed` stale by stamping `invalidated_at` on its
 * live evidence. The changed clauses themselves need no stamp: their text
 * change already minted a new revision, so verify re-runs them regardless.
 */
export const propagateStale = (
  db: Database,
  changed: ClauseKey[],
  timestamp: number,
  changedRequirements: RequirementKey[] = []
): StaleReport => {
  if (changed.length === 0 && changedRequirements.length === 0) {
    return { staleClauses: [], invalidatedEvidence: 0 }
  }
  ensureEvidenceLedger(db)
  const graph = liveGraph(db)
  const uniqueClauses = (clauses: ClauseKey[]): ClauseKey[] => {
    const seen = new Set<string>()
    return clauses.filter((clause) => {
      const key = keyOf(clause.specPath, clause.clauseId)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const matchesChangedRequirement = (edge: ReqEdge, requirement: RequirementKey): boolean => {
    if (edge.to_req !== requirement.reqId) return false
    if (edge.to_spec !== '') return edge.to_spec === requirement.specPath
    const sourceFeature = featureOf(edge.spec_path)
    return sourceFeature !== null && sourceFeature === featureOf(requirement.specPath)
  }
  const directRequirementDependents = uniqueClauses(
    graph.reqEdges.flatMap((edge) =>
      changedRequirements.some((requirement) => matchesChangedRequirement(edge, requirement))
        ? [{ specPath: edge.spec_path, clauseId: edge.clause_id }]
        : []
    )
  )
  const roots = uniqueClauses([...changed, ...directRequirementDependents])
  const downstream = reverseClosure(graph.edges, roots)
  const staleClauses = uniqueClauses([...directRequirementDependents, ...downstream])

  const invalidate = db.prepare(
    `UPDATE evidence SET invalidated_at = ?
     WHERE spec_path = ? AND clause_id = ? AND invalidated_at IS NULL`
  )
  let invalidatedEvidence = 0
  db.transaction(() => {
    for (const clause of staleClauses) {
      invalidatedEvidence += invalidate.run(timestamp, clause.specPath, clause.clauseId).changes
    }
  })()
  return { staleClauses, invalidatedEvidence }
}

/**
 * Impact analysis: who breaks if this clause changes? Mechanical readout of
 * the refs graph — reverse closure plus every task citing an affected clause
 * in its feature unit's checklist.
 */
export const impact = (db: Database, source: ClauseKey): ImpactReport => {
  const { edges } = liveGraph(db)
  const affectedClauses = reverseClosure(edges, [source])

  // Tasks live in specs/<feature>/tasks.md and cite clause ids unit-locally.
  const taskStmt = db.prepare(
    `SELECT t.file_id, t.title, t.clauses
     FROM tasks t
     JOIN (
       SELECT spec_path, MAX(revision) AS revision
       FROM revisions WHERE file_kind = 'tasks' GROUP BY spec_path
     ) latest ON latest.spec_path = t.spec_path AND latest.revision = t.revision
     WHERE t.spec_path = ?
     ORDER BY t.seq`
  )

  const affectedTasks: ImpactReport['affectedTasks'] = []
  const seenTasks = new Set<string>()
  for (const clause of [source, ...affectedClauses]) {
    const feature = featureOf(clause.specPath)
    if (!feature) continue
    const taskPath = `specs/${feature}/tasks.md`
    const rows = taskStmt.all(taskPath) as { file_id: string; title: string; clauses: string }[]
    for (const row of rows) {
      const cited: unknown = JSON.parse(row.clauses)
      if (!Array.isArray(cited) || !cited.includes(clause.clauseId)) continue
      const dedupe = `${taskPath}#${row.file_id}#${clause.clauseId}`
      if (seenTasks.has(dedupe)) continue
      seenTasks.add(dedupe)
      affectedTasks.push({
        specPath: taskPath,
        fileId: row.file_id,
        title: row.title,
        clauseId: clause.clauseId,
      })
    }
  }

  return { source, affectedClauses, affectedTasks }
}

/** Live requirements with no uniquely resolved live clause binding. */
export const uncoveredRequirements = (db: Database): RequirementCoverage[] => {
  const graph = liveGraph(db)
  const covered = new Set<string>()
  for (const edge of graph.reqEdges) {
    const candidates = resolveReq(graph, edge)
    if (candidates.length !== 1) continue
    const requirement = candidates[0]
    if (requirement) covered.add(keyOf(requirement.specPath, requirement.reqId))
  }

  const stmt = db.prepare(
    'SELECT req_id, title FROM requirements WHERE spec_path = ? AND revision = ? ORDER BY seq'
  )
  const uncovered: RequirementCoverage[] = []
  for (const { spec_path, revision } of graph.revisions) {
    for (const row of stmt.all(spec_path, revision) as { req_id: string; title: string }[]) {
      if (covered.has(keyOf(spec_path, row.req_id))) continue
      uncovered.push({ specPath: spec_path, reqId: row.req_id, title: row.title })
    }
  }
  return uncovered
}
