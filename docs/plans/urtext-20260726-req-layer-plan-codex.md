# Urtext Requirement Layer (FR) — Codex technical plan

Planning date: 2026-07-26. This plan is implementation-ready but has not been executed. The owner contract in [`.urtext/req-layer-brief.md`](../../.urtext/req-layer-brief.md) is binding; in particular, FR headings, `req:`, fail-closed indexing, `unknown_req`, stale propagation, uncovered-FR status, dogfood migration, and the `SYNTAX.md` evolution record are not optional.

Grounding used for the design:

- The current parser recognizes only `C\d+` headings, treats any heading as a body terminator, parses whitespace-delimited anchor fields, and fails closed on parse errors (`src/clause-parser.ts:1-15`, `src/clause-parser.ts:34-73`, `src/clause-parser.ts:138-215`; `src/anchor.ts:1-38`).
- A file owns one append-only `(spec_path, revision)` chain. Clause rows and ref edges are snapshots under that chain, and an invalid parse produces a persisted `building` revision (`src/registry.ts:1-15`, `src/registry.ts:58-126`, `src/registry.ts:150-223`).
- The linker evaluates all latest non-tombstoned clause-file revisions, reports dangling refs at check stage, and invalidates evidence over the reverse `refs` closure (`src/linker.ts:53-107`, `src/linker.ts:109-162`).
- `status` currently emits `urtext.status/1`, an item-keyed two-lane queue; the CLI exits non-zero when the queue is non-empty (`src/status.ts:27-77`, `src/status.ts:153-194`; `src/cli.ts:383-434`).
- Scanner discovery already includes every non-`tasks.md` Markdown file directly below `specs/<feature>/`, so an FR-only file is discoverable without a new walker (`src/scanner.ts:45-75`).

## 1. Data model: FR declarations, req edges, and schema migration

### Decision 1.1 — FRs share their containing file's revision chain

Store declarations in a new `requirements` snapshot table keyed by `(spec_path, revision, requirement_id)`. Store clause bindings in `clause_requirements`, versioned by the source clause's `(spec_path, revision)`. A requirement's stable workspace identity is `spec_path#FR<n>`; its bare-ID namespace is the feature unit, not the whole workspace.

**Rejected alternative — a separate requirement revision chain:** it would allow the clause and FR views of one Markdown snapshot to advance independently, breaking the current atomic file-reconciliation invariant.

### Decision 1.2 — keep both parsed JSON and normalized edges

Add `clauses.reqs` as the serialized parser result and `clause_requirements` as the queryable edge set. Empty `to_spec` means a bare, feature-local reference; a non-empty value preserves an explicit `path#FR<n>` without resolving it at index time.

**Rejected alternative — only a `reqs` JSON column:** `unknown_req`, reverse binding lookup, and uncovered-FR queries would require repeated JSON parsing and could diverge between call sites.

**Rejected alternative — resolve bare IDs to paths while indexing:** resolution depends on the latest whole-workspace snapshot and must detect a target added, moved, duplicated, or tombstoned even when the source file is unchanged, exactly as `unknown_ref` does today (`src/linker.ts:87-107`).

### Decision 1.3 — version parser semantics, not just storage shape

Add `revisions.grammar_version`. `indexClauseFile` may return `unchanged` only when both `content_hash` and `grammar_version` match. Existing rows migrate with version `0`; the FR-capable parser writes version `1`. Thus the first post-upgrade scan appends a new revision even for byte-identical old files, and a legacy clause without `req:` becomes `building` instead of silently retaining its old `ready` row. Historical rows are never updated or inferred.

**Rejected alternative — add tables/columns and leave the content-hash no-op unchanged:** an existing registry would never reparse unchanged specs under the new mandatory-`req` grammar, violating the pinned fail-closed contract.

**Rejected alternative — rewrite old revision statuses in place:** that destroys the append-only audit history guaranteed by the current registry (`src/registry.ts:5-11`) and defended by `tests/registry.test.ts:27-49`.

### Exact SQLite DDL and additive migration

The following is real SQL/TypeScript intended for `REGISTRY_SCHEMA` and `openRegistry`. Fresh databases receive the new columns in their `CREATE TABLE` definitions; `pragma_table_info` handles existing databases idempotently.

```ts
export const REGISTRY_GRAMMAR_VERSION = 1

export const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS revisions (
  spec_path       TEXT    NOT NULL,
  revision        INTEGER NOT NULL,
  file_kind       TEXT    NOT NULL CHECK (file_kind IN ('clauses', 'tasks')),
  content_hash    TEXT,
  status          TEXT    NOT NULL CHECK (status IN ('ready', 'building', 'tombstoned')),
  created_at      INTEGER NOT NULL,
  grammar_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (spec_path, revision),
  CHECK ((status = 'tombstoned') = (content_hash IS NULL)),
  CHECK (content_hash IS NULL OR content_hash GLOB 'sha256:*')
);

CREATE TABLE IF NOT EXISTS clauses (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL DEFAULT '',
  oracle_kind TEXT,
  oracle_ref  TEXT,
  risk        TEXT    NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'high')),
  refs        TEXT    NOT NULL DEFAULT '[]',
  reqs        TEXT    NOT NULL DEFAULT '[]',
  body        TEXT,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id),
  FOREIGN KEY (spec_path, revision)
    REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirements (
  spec_path       TEXT    NOT NULL,
  revision        INTEGER NOT NULL,
  requirement_id  TEXT    NOT NULL,
  seq             INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  text_hash       TEXT    NOT NULL,
  body            TEXT,
  line            INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, requirement_id),
  FOREIGN KEY (spec_path, revision)
    REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  file_id     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  checked     INTEGER NOT NULL DEFAULT 0,
  role        TEXT,
  prompt      TEXT,
  depends_on  TEXT    NOT NULL DEFAULT '[]',
  human_gate  INTEGER NOT NULL DEFAULT 0,
  clauses     TEXT    NOT NULL DEFAULT '[]',
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, file_id),
  FOREIGN KEY (spec_path, revision)
    REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clause_refs (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  to_spec     TEXT    NOT NULL,
  to_clause   TEXT    NOT NULL,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id, to_spec, to_clause),
  FOREIGN KEY (spec_path, revision)
    REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clause_requirements (
  spec_path      TEXT    NOT NULL,
  revision       INTEGER NOT NULL,
  clause_id      TEXT    NOT NULL,
  to_spec        TEXT    NOT NULL DEFAULT '',
  to_requirement TEXT    NOT NULL,
  line           INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id, to_spec, to_requirement),
  FOREIGN KEY (spec_path, revision, clause_id)
    REFERENCES clauses (spec_path, revision, clause_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS requirement_id_lookup
  ON requirements (requirement_id, spec_path, revision);
CREATE INDEX IF NOT EXISTS requirement_reverse_lookup
  ON clause_requirements (to_requirement, to_spec, spec_path, revision);
`

const addColumnIfMissing = (
  db: Database,
  table: string,
  column: string,
  ddl: string
): void => {
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as { name: string }[]
  if (!columns.some((entry) => entry.name === column)) db.exec(ddl)
}

export const openRegistry = (db: Database): void => {
  db.transaction(() => {
    db.exec(REGISTRY_SCHEMA)
    addColumnIfMissing(
      db,
      'clauses',
      'text_hash',
      `ALTER TABLE clauses ADD COLUMN text_hash TEXT NOT NULL DEFAULT ''`
    )
    addColumnIfMissing(
      db,
      'clauses',
      'reqs',
      `ALTER TABLE clauses ADD COLUMN reqs TEXT NOT NULL DEFAULT '[]'`
    )
    addColumnIfMissing(
      db,
      'revisions',
      'grammar_version',
      `ALTER TABLE revisions ADD COLUMN grammar_version INTEGER NOT NULL DEFAULT 0`
    )
  })()
}
```

Implementation note: `pragma_table_info(?)` must be verified against the installed `better-sqlite3`/SQLite binding. If table-valued pragma parameters are rejected, use the existing fixed-table query form three times; never interpolate a caller-provided identifier.

**Rejected alternative — a destructive `CREATE TABLE ... AS` migration:** additive columns and new child tables are sufficient, so rebuilding `revisions` would create needless foreign-key and crash-recovery risk.

## 2. Parser changes: FR headings, req grammar, and fail-closed errors

### Decision 2.1 — parse FRs and clauses in one ordered pass

Use a distinct `REQUIREMENT_LINE` beside the pinned clause regex. Both declarations use the existing `ANY_HEADING` body boundary. Requirements and clauses keep independent `seq` counters because their display order is meaningful within their own type, while `line` preserves their shared file position.

**Rejected alternative — pre-split the Markdown into FR sections and clause sections:** the pinned grammar allows either heading anywhere in any clause file; section-based parsing would invent an ordering restriction.

### Decision 2.2 — represent an unresolved req target explicitly

`RequirementRef.path` is `null` for bare `FR<n>` and a string for explicit `path#FR<n>`. The parser validates syntax only. It deduplicates identical tokens, preserving first occurrence order.

**Rejected alternative — store the source feature name as the path for a bare ref:** that conflates a resolution scope with a concrete file and cannot represent an FR moved between files inside the same feature.

### Decision 2.3 — specific errors win over duplicate noise

An absent `req` field emits `missing_requirement`. A present but empty or malformed entry emits `malformed_req`; it does not also emit `missing_requirement`. FRs emit `oracle_on_requirement` and `risk_on_requirement` when those keys are present, even with an empty value. Same-file duplicate FR IDs emit `duplicate_requirement_id`. All errors keep the revision `building` through the existing `parsed.errors.length` check (`src/registry.ts:161-164`).

**Rejected alternative — report both `malformed_req` and `missing_requirement` for the same bad token:** one root cause would produce redundant diagnostics without making indexing more fail-closed.

### Exact parser types and implementation

This is an implementation-sized replacement for the relevant declarations and `parseClauseFile`; it deliberately reuses `parseAnchorFields`, the current oracle/risk logic, and zero-based error lines.

```ts
export interface RequirementRef {
  /** null means bare FR<n>, resolved in the source feature unit. */
  path: string | null
  requirementId: string
}

export interface ParsedRequirement {
  requirementId: string
  seq: number
  title: string
  level: number
  body: string | null
  line: number
}

export interface ParsedClause {
  clauseId: string
  seq: number
  title: string
  level: number
  oracle: ClauseOracle | null
  risk: 'low' | 'high'
  refs: ClauseRef[]
  reqs: RequirementRef[]
  body: string | null
  line: number
}

export interface ClauseParseError {
  code:
    | 'missing_oracle'
    | 'missing_requirement'
    | 'invalid_oracle_kind'
    | 'invalid_risk'
    | 'duplicate_clause_id'
    | 'duplicate_requirement_id'
    | 'oracle_on_requirement'
    | 'risk_on_requirement'
    | 'malformed_anchor'
    | 'malformed_ref'
    | 'malformed_req'
  clauseId?: string
  requirementId?: string
  line: number
  message: string
}

export interface ParsedClauseFile {
  requirements: ParsedRequirement[]
  clauses: ParsedClause[]
  errors: ClauseParseError[]
}

const CLAUSE_LINE = /^(#{1,6})\s+(C\d+)\b\s*(.*)$/
const REQUIREMENT_LINE = /^(#{1,6})\s+(FR\d+)\b\s*(.*)$/
const ANY_HEADING = /^#{1,6}\s+/
const ANCHOR = /<!--\s*(.*?)\s*-->/

const bodyAfter = (lines: string[], line: number): string | null => {
  const bodyLines: string[] = []
  for (let index = line + 1; index < lines.length; index++) {
    const candidate = lines[index]
    if (candidate === undefined || ANY_HEADING.test(candidate)) break
    bodyLines.push(candidate)
  }
  return bodyLines.join('\n').trim() || null
}

const anchorAt = (
  rest: string,
  line: number,
  owner: { kind: 'clause'; id: string } | { kind: 'requirement'; id: string },
  errors: ClauseParseError[]
): { fields: Record<string, string>; title: string } => {
  const anchorMatch = rest.match(ANCHOR)
  let fields: Record<string, string> = {}
  if (anchorMatch?.[1] !== undefined) {
    const parsed = parseAnchorFields(anchorMatch[1])
    fields = parsed.fields
    for (const issue of parsed.issues) {
      errors.push({
        code: 'malformed_anchor',
        ...(owner.kind === 'clause'
          ? { clauseId: owner.id }
          : { requirementId: owner.id }),
        line,
        message: `${owner.kind === 'clause' ? 'Clause' : 'Requirement'} "${owner.id}": ${issue.message}`,
      })
    }
  }
  return {
    fields,
    title: rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim(),
  }
}

const parseReqs = (
  value: string | undefined,
  line: number,
  clauseId: string
): { reqs: RequirementRef[]; errors: ClauseParseError[] } => {
  if (value === undefined) {
    return {
      reqs: [],
      errors: [{
        code: 'missing_requirement',
        clauseId,
        line,
        message: `Clause "${clauseId}" has no req binding. A normative clause must defend at least one FR<n>.`,
      }],
    }
  }

  const reqs: RequirementRef[] = []
  const errors: ClauseParseError[] = []
  const seen = new Set<string>()
  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    let parsed: RequirementRef | null = null
    if (/^FR\d+$/.test(trimmed)) {
      parsed = { path: null, requirementId: trimmed }
    } else {
      const hash = trimmed.lastIndexOf('#')
      const path = hash === -1 ? '' : trimmed.slice(0, hash)
      const requirementId = hash === -1 ? '' : trimmed.slice(hash + 1)
      if (path && /^FR\d+$/.test(requirementId)) {
        parsed = { path, requirementId }
      }
    }
    if (parsed === null) {
      errors.push({
        code: 'malformed_req',
        clauseId,
        line,
        message: `Clause "${clauseId}" req "${trimmed}" is not "FR<n>" or "<path>#FR<n>".`,
      })
      continue
    }
    const key = `${parsed.path ?? ''}#${parsed.requirementId}`
    if (!seen.has(key)) reqs.push(parsed)
    seen.add(key)
  }
  return { reqs, errors }
}

export const parseClauseFile = (content: string): ParsedClauseFile => {
  const lines = content.split(/\r?\n/)
  const requirements: ParsedRequirement[] = []
  const clauses: ParsedClause[] = []
  const errors: ClauseParseError[] = []
  const seenRequirementIds = new Set<string>()
  const seenClauseIds = new Set<string>()
  let requirementSeq = 0
  let clauseSeq = 0

  for (let line = 0; line < lines.length; line++) {
    const rawLine = lines[line]
    if (rawLine === undefined) continue

    const requirementMatch = rawLine.match(REQUIREMENT_LINE)
    if (requirementMatch) {
      const [, hashes = '#', requirementId = '', rest = ''] = requirementMatch
      const { fields, title } = anchorAt(
        rest,
        line,
        { kind: 'requirement', id: requirementId },
        errors
      )
      if (fields.oracle !== undefined) {
        errors.push({
          code: 'oracle_on_requirement',
          requirementId,
          line,
          message: `Requirement "${requirementId}" must express intent and cannot carry an oracle.`,
        })
      }
      if (fields.risk !== undefined) {
        errors.push({
          code: 'risk_on_requirement',
          requirementId,
          line,
          message: `Requirement "${requirementId}" cannot carry risk; risk belongs to decidable clauses.`,
        })
      }
      if (seenRequirementIds.has(requirementId)) {
        errors.push({
          code: 'duplicate_requirement_id',
          requirementId,
          line,
          message: `Requirement id "${requirementId}" is declared more than once in this file.`,
        })
      }
      seenRequirementIds.add(requirementId)
      requirements.push({
        requirementId,
        seq: ++requirementSeq,
        title,
        level: hashes.length,
        body: bodyAfter(lines, line),
        line,
      })
      continue
    }

    const clauseMatch = rawLine.match(CLAUSE_LINE)
    if (!clauseMatch) continue
    const [, hashes = '#', clauseId = '', rest = ''] = clauseMatch
    const { fields, title } = anchorAt(rest, line, { kind: 'clause', id: clauseId }, errors)
    const { oracle, error: oracleError } = parseOracle(fields.oracle, line, clauseId)
    if (oracleError) errors.push(oracleError)

    let risk: 'low' | 'high' = 'low'
    if (fields.risk !== undefined) {
      if (fields.risk === 'low' || fields.risk === 'high') risk = fields.risk
      else {
        errors.push({
          code: 'invalid_risk',
          clauseId,
          line,
          message: `Clause "${clauseId}" risk "${fields.risk}" is not "low" or "high".`,
        })
      }
    }

    const { refs, errors: refErrors } = parseRefs(fields.refs, line, clauseId)
    const { reqs, errors: reqErrors } = parseReqs(fields.req, line, clauseId)
    errors.push(...refErrors, ...reqErrors)
    if (seenClauseIds.has(clauseId)) {
      errors.push({
        code: 'duplicate_clause_id',
        clauseId,
        line,
        message: `Clause id "${clauseId}" is declared more than once.`,
      })
    }
    seenClauseIds.add(clauseId)
    clauses.push({
      clauseId,
      seq: ++clauseSeq,
      title,
      level: hashes.length,
      oracle,
      risk,
      refs,
      reqs,
      body: bodyAfter(lines, line),
      line,
    })
  }
  return { requirements, clauses, errors }
}
```

`src/anchor.ts` needs only its example/comment updated to show `req:FR001`; the tokenizer is already generic and retains everything after the first colon (`src/anchor.ts:22-36`).

**Rejected alternative — change the shared tokenizer or add quoted anchor values now:** `req` needs only the already-frozen no-space/comma grammar, and quoting would be an unrelated syntax evolution.

## 3. Registry reconciliation: hashes, revision semantics, and fail-closed persistence

### Decision 3.1 — hash only FR intent text

`requirement.text_hash = sha256(title + "\n" + body)`, exactly parallel to `clauseTextHash` (`src/registry.ts:141-142`). Heading depth and anchor text do not participate. Any title/body addition, deletion, or edit appears in `changedRequirements`; an FR removed from a still-present file also appears as changed.

**Rejected alternative — include heading level or HTML anchor in the hash:** the pinned contract defines FR text as title+body, and illegal oracle/risk metadata already blocks indexing rather than representing intent.

### Decision 3.2 — persist broken snapshots first-wins, as clauses do today

Requirements and req edges are inserted even when the revision is `building`; duplicate IDs retain the first declaration so the broken edit remains inspectable without violating the PK. Link/check still use latest non-tombstoned snapshots, which is the current conservative behavior for building clause revisions (`src/linker.ts:53-65`).

**Rejected alternative — roll back all rows when parsing fails:** that would hide the current broken definition and make repeat diagnostics depend on reparsing only, unlike today's fail-closed registry behavior (`src/registry.ts:191-215`).

### Real reconciliation code

```ts
const requirementTextHash = (title: string, body: string | null): string =>
  `sha256:${createHash('sha256').update(`${title}\n${body ?? ''}`, 'utf8').digest('hex')}`

// latestRevision also SELECTs grammar_version.
if (
  latest &&
  latest.status !== 'tombstoned' &&
  latest.content_hash === contentHash &&
  latest.grammar_version === REGISTRY_GRAMMAR_VERSION
) {
  return { kind: 'unchanged', revision: latest.revision, status: latest.status }
}

const priorRequirementHashes = new Map<string, string>()
const priorClauseHashes = new Map<string, string>()
if (latest && latest.status !== 'tombstoned') {
  const requirementRows = db.prepare(
    `SELECT requirement_id, text_hash FROM requirements
     WHERE spec_path = ? AND revision = ?`
  ).all(specPath, latest.revision) as { requirement_id: string; text_hash: string }[]
  for (const row of requirementRows) {
    priorRequirementHashes.set(row.requirement_id, row.text_hash)
  }
  const clauseRows = db.prepare(
    `SELECT clause_id, text_hash FROM clauses
     WHERE spec_path = ? AND revision = ?`
  ).all(specPath, latest.revision) as { clause_id: string; text_hash: string }[]
  for (const row of clauseRows) priorClauseHashes.set(row.clause_id, row.text_hash)
}

const changedClauses: string[] = []
const changedRequirements: string[] = []
db.transaction(() => {
  db.prepare(
    `INSERT INTO revisions
       (spec_path, revision, file_kind, content_hash, status, created_at, grammar_version)
     VALUES (?, ?, 'clauses', ?, ?, ?, ?)`
  ).run(
    specPath,
    nextRevision,
    contentHash,
    status,
    timestamp,
    REGISTRY_GRAMMAR_VERSION
  )

  const insertRequirement = db.prepare(
    `INSERT INTO requirements
       (spec_path, revision, requirement_id, seq, title, text_hash, body, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertedRequirements = new Set<string>()
  for (const requirement of parsed.requirements) {
    if (insertedRequirements.has(requirement.requirementId)) continue
    insertedRequirements.add(requirement.requirementId)
    const textHash = requirementTextHash(requirement.title, requirement.body)
    if (priorRequirementHashes.get(requirement.requirementId) !== textHash) {
      changedRequirements.push(requirement.requirementId)
    }
    insertRequirement.run(
      specPath,
      nextRevision,
      requirement.requirementId,
      requirement.seq,
      requirement.title,
      textHash,
      requirement.body,
      requirement.line
    )
  }
  for (const requirementId of priorRequirementHashes.keys()) {
    if (!insertedRequirements.has(requirementId)) changedRequirements.push(requirementId)
  }

  const insertClause = db.prepare(
    `INSERT INTO clauses
       (spec_path, revision, clause_id, seq, title, text_hash, oracle_kind,
        oracle_ref, risk, refs, reqs, body, line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertRequirementEdge = db.prepare(
    `INSERT OR IGNORE INTO clause_requirements
       (spec_path, revision, clause_id, to_spec, to_requirement, line)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertRef = db.prepare(
    `INSERT OR IGNORE INTO clause_refs
       (spec_path, revision, clause_id, to_spec, to_clause, line)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertedClauses = new Set<string>()
  for (const clause of parsed.clauses) {
    if (insertedClauses.has(clause.clauseId)) continue
    insertedClauses.add(clause.clauseId)
    const textHash = clauseTextHash(clause.title, clause.body)
    if (priorClauseHashes.get(clause.clauseId) !== textHash) {
      changedClauses.push(clause.clauseId)
    }
    insertClause.run(
      specPath,
      nextRevision,
      clause.clauseId,
      clause.seq,
      clause.title,
      textHash,
      clause.oracle?.kind ?? null,
      clause.oracle?.ref ?? null,
      clause.risk,
      JSON.stringify(clause.refs),
      JSON.stringify(clause.reqs),
      clause.body,
      clause.line
    )
    for (const ref of clause.refs) {
      insertRef.run(
        specPath,
        nextRevision,
        clause.clauseId,
        ref.path,
        ref.clauseId,
        clause.line
      )
    }
    for (const req of clause.reqs) {
      insertRequirementEdge.run(
        specPath,
        nextRevision,
        clause.clauseId,
        req.path ?? '',
        req.requirementId,
        clause.line
      )
    }
  }
  for (const clauseId of priorClauseHashes.keys()) {
    if (!insertedClauses.has(clauseId)) changedClauses.push(clauseId)
  }
})()

return {
  kind: 'indexed',
  revision: nextRevision,
  status,
  errors: parsed.errors,
  changedClauses,
  changedRequirements,
}
```

Extend the indexed `IndexOutcome` with `changedRequirements: string[]`; task outcomes return both change arrays empty. Both clause and task revision inserts write `REGISTRY_GRAMMAR_VERSION`, although only clause no-op logic needs the FR reparse gate.

**Rejected alternative — backfill FR/req rows into historical revisions:** the old parser never observed those concepts; fabricating history from the current file would falsely claim prior knowledge and mutate append-only meaning.

Update `src/index.ts` exports for `RequirementRef`, `ParsedRequirement`, `RequirementKey`, and the uncovered status type because the package has a declared public entry point (`src/index.ts:1-38`, `src/index.ts:124-132`).

**Rejected alternative — leave new domain types internal:** consumers already receive parser, linker, and status types from the package surface, so omitting only the new counterparts would make the API incoherent.

## 4. Linker: unknown_req and FR-to-clause stale propagation

### Decision 4.1 — resolve requirements over the latest non-tombstoned snapshot

Augment `liveGraph` with live requirement declarations and live requirement edges. A non-empty `to_spec` requires an exact `spec_path#FR<n>` match. A bare edge matches the same `specs/<feature>/` and ID. Zero candidates is `unknown_req`, reported alongside `unknown_ref`; `urtext check` already turns every linker error into exit 1 (`src/cli.ts:739-760`, `src/cli.ts:811-814`).

**Rejected alternative — mark the source revision `building` when a target disappears:** an unchanged source revision cannot be mutated without violating history, and the current `unknown_ref` rationale explicitly assigns target-side drift to workspace check (`src/linker.ts:87-92`).

### Decision 4.2 — make the bare namespace deterministic

Two live files in one feature declaring the same FR ID produce a check-stage `duplicate_requirement_id`. A same-file duplicate is already a parse-stage error. Explicit path references do not excuse a duplicated feature-local namespace because future bare refs would change meaning based on file ordering.

**Rejected alternative — pick the lexicographically first declaration:** silent winner selection would let moving or renaming a file retarget clauses without changing their anchors.

### Real unknown_req validation code

```ts
export interface RequirementKey {
  specPath: string
  requirementId: string
}

interface RequirementRow {
  spec_path: string
  requirement_id: string
  title: string
  line: number
}

interface RequirementEdge {
  spec_path: string
  clause_id: string
  to_spec: string
  to_requirement: string
  line: number
}

interface LiveGraph {
  declaredClauses: Set<string>
  refEdges: RefEdge[]
  requirements: RequirementRow[]
  requirementEdges: RequirementEdge[]
}

export type LinkError =
  | {
      code: 'unknown_ref'
      specPath: string
      clauseId: string
      line: number
      message: string
    }
  | {
      code: 'unknown_req'
      specPath: string
      clauseId: string
      requirementId: string
      line: number
      message: string
    }
  | {
      code: 'duplicate_requirement_id'
      specPath: string
      requirementId: string
      line: number
      message: string
    }

const featureOf = (specPath: string): string | null =>
  specPath.match(/^specs\/([^/]+)\//)?.[1] ?? null

const requirementKey = (specPath: string, requirementId: string): string =>
  `${specPath}#${requirementId}`

const requirementCandidates = (
  graph: LiveGraph,
  edge: RequirementEdge
): RequirementRow[] => {
  if (edge.to_spec !== '') {
    return graph.requirements.filter(
      (requirement) =>
        requirement.spec_path === edge.to_spec &&
        requirement.requirement_id === edge.to_requirement
    )
  }
  const feature = featureOf(edge.spec_path)
  return graph.requirements.filter(
    (requirement) =>
      featureOf(requirement.spec_path) === feature &&
      requirement.requirement_id === edge.to_requirement
  )
}

const liveGraph = (db: Database): LiveGraph => {
  const declaredClauses = new Set<string>()
  const refEdges: RefEdge[] = []
  const requirements: RequirementRow[] = []
  const requirementEdges: RequirementEdge[] = []
  const clauseStmt = db.prepare(
    `SELECT clause_id FROM clauses
     WHERE spec_path = ? AND revision = ? ORDER BY seq`
  )
  const refStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_clause, line
     FROM clause_refs WHERE spec_path = ? AND revision = ?
     ORDER BY clause_id, to_spec, to_clause`
  )
  const requirementStmt = db.prepare(
    `SELECT spec_path, requirement_id, title, line
     FROM requirements WHERE spec_path = ? AND revision = ?
     ORDER BY seq`
  )
  const requirementEdgeStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_requirement, line
     FROM clause_requirements WHERE spec_path = ? AND revision = ?
     ORDER BY clause_id, to_spec, to_requirement`
  )
  for (const { spec_path, revision } of liveClauseRevisions(db)) {
    for (const row of clauseStmt.all(spec_path, revision) as { clause_id: string }[]) {
      declaredClauses.add(keyOf(spec_path, row.clause_id))
    }
    refEdges.push(...(refStmt.all(spec_path, revision) as RefEdge[]))
    requirements.push(
      ...(requirementStmt.all(spec_path, revision) as RequirementRow[])
    )
    requirementEdges.push(
      ...(requirementEdgeStmt.all(spec_path, revision) as RequirementEdge[])
    )
  }
  return { declaredClauses, refEdges, requirements, requirementEdges }
}

export const linkWorkspace = (db: Database): LinkError[] => {
  const graph = liveGraph(db)
  const errors: LinkError[] = []

  for (const edge of graph.refEdges) {
    if (graph.declaredClauses.has(keyOf(edge.to_spec, edge.to_clause))) continue
    errors.push({
      code: 'unknown_ref',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      line: edge.line,
      message: `Clause "${edge.clause_id}" refs "${edge.to_spec}#${edge.to_clause}" which does not exist.`,
    })
  }

  const byFeatureId = new Map<string, RequirementRow[]>()
  for (const requirement of graph.requirements) {
    const key = `${featureOf(requirement.spec_path) ?? ''}#${requirement.requirement_id}`
    const group = byFeatureId.get(key) ?? []
    group.push(requirement)
    byFeatureId.set(key, group)
  }
  for (const group of byFeatureId.values()) {
    if (group.length < 2) continue
    const first = group[0]!
    errors.push({
      code: 'duplicate_requirement_id',
      specPath: first.spec_path,
      requirementId: first.requirement_id,
      line: first.line,
      message: `Requirement "${first.requirement_id}" is declared by multiple files in feature "${featureOf(first.spec_path)}": ${group.map((item) => item.spec_path).join(', ')}.`,
    })
  }

  for (const edge of graph.requirementEdges) {
    if (requirementCandidates(graph, edge).length > 0) continue
    const target = edge.to_spec === ''
      ? edge.to_requirement
      : `${edge.to_spec}#${edge.to_requirement}`
    errors.push({
      code: 'unknown_req',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      requirementId: edge.to_requirement,
      line: edge.line,
      message: `Clause "${edge.clause_id}" req "${target}" which does not exist.`,
    })
  }
  return errors
}
```

`liveGraph` must query requirements and `clause_requirements` for the same `liveClauseRevisions` rows used for clauses/refs, with explicit `ORDER BY spec_path, seq` (declarations) and `ORDER BY spec_path, clause_id, to_requirement` (edges) for deterministic diagnostics.

**Rejected alternative — a second linker pass with independently selected revisions:** two “latest” queries could observe different snapshots if a caller writes between them; one graph object keeps validation, coverage, and stale resolution coherent within the synchronous scan.

### Decision 4.3 — direct bindings become stale roots, then refs propagate transitively

When an FR title/body changes, every live clause whose raw req edge targets that FR is included directly in `staleClauses` and has current evidence invalidated. Those clauses then seed the existing reverse `clause_refs` closure so their downstream dependents also become stale. Changed clauses retain today's behavior: they seed propagation but are not invalidated merely for their own text revision.

For a removed FR, matching uses the raw edge plus the changed FR's old key, not only current declaration candidates; otherwise removal would produce `unknown_req` but fail to invalidate clauses that had depended on it.

**Rejected alternative — synthesize FR nodes into `clause_refs`:** requirements are not clauses, have no oracle/evidence, and would contaminate `impact`, task lookup, and every query that assumes `C<n>` nodes.

### Real stale-propagation code

```ts
const sameRequirementTarget = (
  edge: RequirementEdge,
  changed: RequirementKey
): boolean => {
  if (edge.to_requirement !== changed.requirementId) return false
  if (edge.to_spec !== '') return edge.to_spec === changed.specPath
  return featureOf(edge.spec_path) === featureOf(changed.specPath)
}

const uniqueClauses = (clauses: ClauseKey[]): ClauseKey[] => {
  const seen = new Set<string>()
  return clauses.filter((clause) => {
    const key = keyOf(clause.specPath, clause.clauseId)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const propagateStale = (
  db: Database,
  changedClauses: ClauseKey[],
  timestamp: number,
  changedRequirements: RequirementKey[] = []
): StaleReport => {
  if (changedClauses.length === 0 && changedRequirements.length === 0) {
    return { staleClauses: [], invalidatedEvidence: 0 }
  }
  ensureEvidenceLedger(db)
  const graph = liveGraph(db)
  const directRequirementDependents = uniqueClauses(
    graph.requirementEdges.flatMap((edge) =>
      changedRequirements.some((changed) => sameRequirementTarget(edge, changed))
        ? [{ specPath: edge.spec_path, clauseId: edge.clause_id }]
        : []
    )
  )
  const propagationRoots = uniqueClauses([
    ...changedClauses,
    ...directRequirementDependents,
  ])
  const downstream = reverseClosure(graph.refEdges, propagationRoots)
  const staleClauses = uniqueClauses([
    ...directRequirementDependents,
    ...downstream,
  ])

  const invalidate = db.prepare(
    `UPDATE evidence SET invalidated_at = ?
     WHERE spec_path = ? AND clause_id = ? AND invalidated_at IS NULL`
  )
  let invalidatedEvidence = 0
  db.transaction(() => {
    for (const clause of staleClauses) {
      invalidatedEvidence += invalidate.run(
        timestamp,
        clause.specPath,
        clause.clauseId
      ).changes
    }
  })()
  return { staleClauses, invalidatedEvidence }
}
```

Scanner collects both change kinds and calls:

```ts
const changedRequirements: RequirementKey[] = []
// For each indexed clause-file outcome:
for (const requirementId of outcome.changedRequirements) {
  changedRequirements.push({ specPath, requirementId })
}

const linkErrors = linkWorkspace(db)
const stale = propagateStale(db, changedClauses, timestamp, changedRequirements)
```

Keep the positional `changedRequirements` argument optional so current package callers of `propagateStale(db, clauses, timestamp)` remain source-compatible.

**Rejected alternative — replace the function with a new object argument immediately:** that would create an avoidable public API break for a feature that can be added compatibly (`src/index.ts:30-38`).

Finally, make `src/brief.ts:206-211` say “unresolved link error(s)” and list actual codes rather than telling users every linker failure is `unknown_ref`; otherwise a clause blocked by `unknown_req` receives a false remediation hint.

**Rejected alternative — leave brief wording alone because check already fails:** `brief` is itself fail-closed on linker errors, and its current message would direct the operator to fix the wrong field.

## 5. Status: uncovered-FR report shape

### Decision 5.1 — a separate human requirement section, not a clause blocker

Add `uncoveredRequirements` to `StatusReport` and bump the schema to `urtext.status/2`. Each entry is explicitly `lane: 'human'`, but it is not a `StatusItem`: it has no oracle remediation, clause risk, or brief target. `counts.uncovered` is explicit; `counts.human` includes uncovered requirements so the headline and WIP reflect all human attention. `autoPass` remains clause-only.

**Rejected alternative — encode an uncovered FR as `StatusItem.kind = 'clause'`:** renderers would create invalid clause brief links, and the item-keyed invariant in `status.ts:13-16` is about adjudicating a clause once, not requirement coverage.

**Rejected alternative — report uncovered FRs in `urtext check`:** the pinned contract calls this human-lane information, while only dangling reqs and invalid indexing are enforcement failures; coverage does not make a valid FR declaration structurally invalid.

### Decision 5.2 — only uniquely resolved live bindings count as coverage

The linker exposes `uncoveredRequirements(db)`: build the same live graph, resolve every requirement edge, count an edge only when it has exactly one candidate, and return unbound live declarations sorted by path/sequence. Ambiguous duplicates therefore remain uncovered as well as link-broken.

**Rejected alternative — count matching raw IDs without resolution:** a dangling explicit path or duplicated bare ID could falsely make an FR look covered.

### Real status report shape and builder changes

```ts
export interface UncoveredRequirementStatus {
  key: string
  kind: 'requirement'
  lane: 'human'
  reason: 'uncovered_requirement'
  next: string
  specPath: string
  requirementId: string
  title: string
  line: number
}

export interface StatusReport {
  schema: 'urtext.status/2'
  head: string | null
  items: StatusItem[]
  uncoveredRequirements: UncoveredRequirementStatus[]
  counts: {
    agent: number
    human: number
    uncovered: number
    autoPass: number
  }
  wip: { limit: number; exceeded: boolean }
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
  const uncoveredRequirements: UncoveredRequirementStatus[] = uncoveredRequirementsIn(
    db
  ).map((requirement) => ({
    key: `${requirement.specPath}#${requirement.requirementId}`,
    kind: 'requirement',
    lane: 'human',
    reason: 'uncovered_requirement',
    next: 'add a decidable clause with req:<FR>, or revise/retire the intent',
    specPath: requirement.specPath,
    requirementId: requirement.requirementId,
    title: requirement.title,
    line: requirement.line + 1,
  }))
  const humanItems = [
    ...unmappedItems,
    ...clauseItems.filter((item) => item.lane === 'human').sort(byRiskThenKey),
  ]
  const agentItems = clauseItems
    .filter((item) => item.lane === 'agent')
    .sort(byRiskThenKey)
  const humanCount = humanItems.length + uncoveredRequirements.length
  const limit = input.wipLimit ?? DEFAULT_WIP_LIMIT
  return {
    schema: 'urtext.status/2',
    head: input.head,
    items: [...humanItems, ...agentItems],
    uncoveredRequirements,
    counts: {
      agent: agentItems.length,
      human: humanCount,
      uncovered: uncoveredRequirements.length,
      autoPass: report.decisions.length - clauseItems.length,
    },
    wip: { limit, exceeded: humanCount > limit },
  }
}
```

The linker-side coverage helper used above is concrete:

```ts
export interface UncoveredRequirement {
  specPath: string
  requirementId: string
  title: string
  line: number
}

export const uncoveredRequirementsIn = (
  db: Database
): UncoveredRequirement[] => {
  const graph = liveGraph(db)
  const covered = new Set<string>()
  for (const edge of graph.requirementEdges) {
    const candidates = requirementCandidates(graph, edge)
    if (candidates.length !== 1) continue
    const requirement = candidates[0]!
    covered.add(requirementKey(requirement.spec_path, requirement.requirement_id))
  }
  return graph.requirements
    .filter((requirement) =>
      !covered.has(requirementKey(requirement.spec_path, requirement.requirement_id))
    )
    .map((requirement) => ({
      specPath: requirement.spec_path,
      requirementId: requirement.requirement_id,
      title: requirement.title,
      line: requirement.line,
    }))
    .sort((left, right) =>
      left.specPath.localeCompare(right.specPath) ||
      left.line - right.line ||
      left.requirementId.localeCompare(right.requirementId)
    )
}
```

`src/cli.ts` prints, after the existing human queue and before the agent lane:

```ts
if (report.uncoveredRequirements.length > 0) {
  console.log(`\nuncovered requirements (${report.uncoveredRequirements.length}, human):`)
  for (const requirement of report.uncoveredRequirements) {
    console.log(`  ? ${requirement.key} ${requirement.title}`)
    console.log(`      next: ${requirement.next}`)
  }
}
const pending = report.items.length + report.uncoveredRequirements.length
return pending > 0 ? 1 : 0
```

JSON consumers receive the new `/2` shape. Text and JSON status both treat uncovered intent as pending human attention; `urtext check` remains green when this is the only issue.

**Rejected alternative — preserve `urtext.status/1` while adding fields:** schema tags exist so consumers can distinguish shapes; silently extending `/1` makes exact decoders unsafe.

## 6. UI (`src/ui/`) minimal impact statement

The UI snapshot embeds `StatusReport` (`src/review-ui.ts:43-66`), and the queue renderer assumes every non-unmapped item is a clause with a brief link (`src/ui/render-console.ts:77-99`). Keeping requirement coverage in its own array prevents that assumption from crashing or creating `undefined#undefined` URLs.

### Decision 6.1 — render one read-only uncovered-intent table on Your queue

Add a small `requirementCoverageSection(snapshot.status.uncoveredRequirements)` below the existing human clause queue, with columns Requirement, Intent, Next. It has no decide/review buttons and no `/brief` link. Update the summary to show `counts.uncovered`; WIP already uses the combined human count. No new endpoint, route, client script, or write path is needed.

**Rejected alternative — defer all UI rendering and expose only CLI status:** the existing UI headline would count hidden human work because it consumes the same status report, which is a misleading operator surface.

### Decision 6.2 — defer FR detail/graph navigation

Do not add FRs to All Specs, `SpecImpactView`, `/api/brief`, or clause navigation in this slice. Those contracts are clause/evidence-centric (`src/ui/contracts.ts:45-87`; `src/review-ui.ts:113-190`), while the owner contract requires only an uncovered-FR status section.

**Rejected alternative — build an FR detail page now:** it expands the feature into requirement editing, FR impact visualization, and a new brief hash domain with no pinned behavior or write contract.

Expected UI test impact is limited to `tests/ui-console.test.ts` summary/queue snapshots and `tests/ui-server.test.ts` route DOM assertions. Existing clause pages and decision handlers should remain byte-for-byte behaviorally unchanged.

**Rejected alternative — exclude UI tests because the new array is additive:** `counts.human` and schema version change exact fixture expectations even if no renderer code imported the array.

## 7. Test plan and verification gates

### Decision 7.1 — test each contract at its owning layer, plus scanner/CLI integration

Do not rely on only a full-suite dogfood pass. Parser tests defend syntax, registry tests defend history/migration, linker tests defend workspace resolution/stale, and status tests defend coverage shape. Add scanner/CLI assertions where exit behavior crosses modules.

**Rejected alternative — only add end-to-end CLI tests:** failures would not distinguish grammar, persistence, resolution, invalidation, and presentation regressions.

### `tests/clause-parser.test.ts`

Add focused cases for:

1. Mixed `FR001` and `C001` headings, independent sequence numbers, levels, title/body, and body termination at any heading.
2. Bare `req:FR001`, explicit `req:specs/platform/requirements.md#FR002`, multiple comma-separated values, and duplicate-token dedupe.
3. Missing `req` → only `missing_requirement`; empty/bad entries → `malformed_req`.
4. FR with `oracle:` → `oracle_on_requirement`; FR with `risk:` → `risk_on_requirement`; both remain parsed for diagnostics.
5. Duplicate same-file FR IDs → `duplicate_requirement_id`.
6. FR-looking prose not at heading start remains ordinary prose; `FR-001` does not match the pinned `FR\d+` grammar.

Update every existing valid clause fixture in this file to declare an FR and add `req:`. For tests intentionally isolating another error, provide a valid requirement binding so the expected error array is not polluted. For the `missing_requirement` case, keep the oracle valid.

**Rejected alternative — loosen old exact error-array assertions to `arrayContaining`:** that would hide accidental secondary parser errors and weaken fail-closed diagnostics.

### `tests/registry.test.ts`

Add cases for:

1. Persisted FR title/body/text hash and normalized bare/explicit requirement edges on the same revision as clauses.
2. FR anchor-only edits do not change FR text hash; title/body edits and removals populate `changedRequirements`.
3. Parser errors `missing_requirement`, `oracle_on_requirement`, and `risk_on_requirement` persist a `building` revision.
4. A handcrafted legacy schema/data row (no `grammar_version`, no `reqs`, no new tables) survives `openRegistry`; columns/tables appear; old rows remain unchanged.
5. Same content at grammar version 0 appends version 1 rather than no-op, and missing `req` is reclassified as building. A second scan under version 1 is the normal no-op.
6. FR-only files index `ready` and appear as clauseless/uncovered, not parser failures.

Update `VALID_CLAUSES` and scanner fixtures with real FR headings and `req:` fields. Update the empty-workspace `ScanReport` exact assertion if the report gains any coverage field; otherwise status owns coverage and the scanner shape remains unchanged (`tests/registry.test.ts:143-153`).

**Rejected alternative — migrate legacy rows by opening the repository's real `.urtext/registry.sqlite` in tests:** tests must be hermetic and must prove a precise pre-upgrade schema without touching developer state.

### `tests/linker.test.ts`

Add cases for:

1. Bare req resolves across two files in the same feature; the same ID in another feature does not satisfy it.
2. Explicit `path#FR` resolves across features.
3. Missing file/ID, target rename/removal, and a latest tombstone all produce `unknown_req` even if the source is unchanged.
4. Duplicate same-feature FR IDs across files produce `duplicate_requirement_id`; resolution never chooses a winner.
5. An FR title/body change invalidates direct bound-clause evidence and evidence for transitive `refs` dependents, exactly once.
6. FR anchor/heading-level-only edits do not propagate; FR removal does.
7. A cycle in clause refs terminates when seeded by an FR change.
8. Uncovered coverage counts only uniquely resolved live edges and excludes tombstoned declarations.

Update `seedChain` and every link fixture with FR declarations and req bindings while keeping existing `refs` topology unchanged, so old reverse-closure expectations remain meaningful (`tests/linker.test.ts:26-40`, `tests/linker.test.ts:94-143`).

**Rejected alternative — make FR bindings a second generic graph edge and reuse all old expectations unchanged:** direct bound clauses must themselves be stale, unlike changed-clause sources today (`src/linker.ts:136-140`).

### `tests/status.test.ts`

Add cases for:

1. `urtext.status/2` shape and `{ agent, human, uncovered, autoPass }` counts.
2. An FR-only file appears in `uncoveredRequirements` with stable key/path/id/title/one-based line, human lane, and next action.
3. One valid local or explicit live clause binding removes the FR from coverage; two clauses still produce one covered FR.
4. Tombstoned/unknown/ambiguous bindings do not count as coverage.
5. Uncovered requirements add to human count/WIP but never enter the agent lane or `items`.
6. CLI text contains the uncovered section; CLI JSON matches `/2`; status exit is 1 while `urtext check` is 0 for uncovered-only intent.

Update `makeRepo` inputs so each existing status fixture includes a valid FR and every clause has `req:`. Update exact counts at `tests/status.test.ts:67-75` to include `uncovered: 0`.

**Rejected alternative — let existing status tests run with newly uncovered FRs:** that would conflate evidence-lane behavior with the new coverage lane and obscure regressions in both.

### Repository-wide fixture migration

Mandatory `req:` affects more than the four owner-listed tests. Sweep every in-memory/on-disk clause fixture found in:

`tests/brief-gate.test.ts`, `tests/brief.test.ts`, `tests/decision.test.ts`, `tests/distill.test.ts`, `tests/dwarf.test.ts`, `tests/gate.test.ts`, `tests/package-consumer.test.ts`, `tests/review-ui.test.ts`, `tests/review.test.ts`, `tests/spec-impact-interactions.test.ts`, `tests/spec-impact-unmapped.test.ts`, `tests/ui-console.test.ts`, `tests/ui-server.test.ts`, `tests/verifier.test.ts`, `tests/verify-failclosed.test.ts`, and `scripts/ui-acceptance-fixture.ts`.

Each valid fixture gets the smallest local `FR001` declaration plus `req:FR001`. Fixtures whose purpose is `missing_requirement` omit only `req`; fixtures for `unknown_req` use a syntactically valid dangling target. Update public export assertions for the new parser/linker/status types.

**Rejected alternative — add a parser compatibility exception for test fixtures or old files:** there is explicitly no config flag or warning mode; production and tests must exercise the same fail-closed contract.

### Implementation verification order (not run during planning)

1. Run the four focused files: `vitest run tests/clause-parser.test.ts tests/registry.test.ts tests/linker.test.ts tests/status.test.ts`.
2. Run affected integration/public-surface tests named above.
3. Run `npm run check` (`tsc --noEmit -p tsconfig.json`, from `package.json:40-45`).
4. Build once with `npm run build`, then run `node dist/cli.js check`; require zero building revisions and zero `unknown_req`/`unknown_ref` errors.
5. Run `npm test` and then the repository's full gate `npm run ci`, which performs strict typecheck, all Vitest tests, build, self-verify, and loop workflow checks (`scripts/full-test.sh:53-70`).
6. Run `node dist/cli.js status --json`; assert schema `/2`, `uncoveredRequirements: []` for the migrated repository, and preserve any unrelated evidence/review queue items as non-coverage state.

**Rejected alternative — claim success from `urtext check` alone:** check proves indexing/link integrity, not evidence execution, public types, UI rendering, or the full repository oracle suite.

## 8. Dogfood migration: actual FR drafts and every clause binding

### Decision 8.1 — group clauses under human intent, not one FR per regression lock

Each feature gets a small, feature-local requirement set. Several clauses may defend one FR, and a clause may bind multiple FRs when it genuinely defends both. This preserves the conceptual difference between intent (FR) and decidable locks (C).

**Rejected alternative — mechanically create one FR per existing clause:** it would produce a tautological second ID layer and make “uncovered intent” impossible to discover in practice.

### `specs/urtext/spec.md`: exact FR text to insert

Insert these declarations after the opening description and before the first clause. They carry no anchor, oracle, or risk field.

```markdown
## FR001 规范性行为必须先被可靠判定，才可进入可执行事实层

规范作者和操作者必须能够确信：每条规范性行为都有明确 oracle，错误或不完整的声明会闭合失败，执行结果会形成可追溯证据并决定命令成败。

## FR002 规范历史与依赖失效必须可追溯且不可被改写

操作者必须能够审计每次规范修订，并在上游事实被修改、移除或悬空时看到所有受影响的下游事实失效，而不是继续信任旧证据。

## FR003 每个代码变更必须能由真实 diff 追溯到规范意图

人和 agent 必须以仓库实际 diff 为准完成 clause→code 归因；无法归因的变更必须被显式处理，不能依赖实施者自述获得放行。

## FR004 风险、证据与异源审计必须把需要判断的工作路由给人

低风险且证据、审计、新鲜度全部满足时系统可自动通过；任何高风险、分歧、人工 oracle 或缺失前置都必须保留原因并交由人裁决，裁决记录绑定当时事实。

## FR005 操作者必须从一个紧凑状态面看见当前全部待办

状态面必须区分 agent 可机械修复的前置项与人类判断项，避免同一事实重复排队，并明确展示尚无 clause 覆盖的需求意图。

## FR006 人工批准前必须获得完整且新鲜的裁决上下文

任何需要人工 review 或 decide 的 clause 都必须提供绑定当前内容、映射代码、证据、审计与影响范围的上下文；上下文过期或工作树不洁净时不得沿用批准。

## FR007 浏览器审查面必须呈现 clause 的真实影响与代码变化

使用 UI 的审查者必须能浏览 live clauses，区分当前 stale 与下游 impact，并看到映射范围内从记录 HEAD 到当前工作树的真实 diff 及明确的缺失/失败状态。

## FR008 CLI 与用户文档必须对同一真实命令能力保持一致

命令面发生变化时必须经过人工确认，面向用户的命令参考必须同步覆盖真实命令集，不能形成第二份悄然漂移的事实源。

## FR009 核心实现必须持续满足严格 TypeScript 构建约束

维护者必须能在 Node 22 与 strict TypeScript 配置下无类型错误地构建完整仓库，使关键事实层不依赖被忽略的类型不一致。

## FR010 每条 clause 必须追溯到已声明需求，且未被防守的需求必须可见

规范作者必须用 `req:` 把每条 decidable clause 绑定到 feature 内或显式路径上的 FR；不存在的绑定必须阻断检查，FR 文本变化必须使已绑定 clause 及其下游证据失效，零 clause 覆盖的 live FR 必须进入人类状态区。
```

#### Existing and new Urtext clause bindings

Add the exact token shown to each existing anchor; preserve every current `oracle`, `risk`, and `refs` token.

| Clause | Add binding | Intent defended |
|---|---|---|
| C001 | `req:FR001` | invalid normative declarations cannot activate |
| C002 | `req:FR001` | invalid checklist→clause declaration fails closed |
| C003 | `req:FR002` | immutable revision history |
| C004 | `req:FR001` | oracle evidence and exit behavior |
| C005 | `req:FR009` | strict typecheck |
| C006 | `req:FR008` | human-confirmed CLI command surface |
| C007 | `req:FR002` | dangling dependency rejection |
| C008 | `req:FR002` | transitive stale/evidence invalidation |
| C009 | `req:FR003` | diff-verified clause→code mapping |
| C010 | `req:FR003` | unmapped-change enforcement |
| C011 | `req:FR004` | read-only heterogeneous meta-audit |
| C012 | `req:FR004` | risk-tier gate routing |
| C013 | `req:FR004` | unsafe-lane HEAD-bound review |
| C014 | `req:FR004` | manual Decision ledger |
| C015 | `req:FR008` | command documentation coverage |
| C016 | `req:FR005` | compact item-keyed two-lane status |
| C017 | `req:FR006` | complete adjudication brief |
| C018 | `req:FR004,FR006` | risk routing plus brief freshness |
| C019 | `req:FR007` | UI impact/mapping truth |

Add four self-hosting clauses so the new feature itself is defended, rather than relying only on unreferenced implementation tests:

```markdown
## C020 FR 与 req 语法在索引时闭合失败 <!-- oracle:test:tests/clause-parser.test.ts risk:high req:FR010 -->

`FR\d+` 标题声明 intent，FR 携带 `oracle:` 或 `risk:` 即报错；每条 `C\d+` 必须至少携带一个语法有效的 `req:`，否则修订保持 `building`。

## C021 悬空 req 与 FR 文本变化被全工作区执法 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C008 req:FR002,FR010 -->

`req:` 在最新 live 修订上解析；目标 FR 不存在时 `unknown_req` 使 `urtext check` 失败。FR 的标题或正文变化时，所有直接绑定 clause 及其 `refs` 下游证据写入 `invalidated_at`。

## C022 status 显示零 clause 覆盖的 live FR <!-- oracle:test:tests/status.test.ts req:FR005,FR010 -->

`urtext status` 以独立人类区列出没有任何唯一解析 live clause 绑定的 FR；这些项不进入 agent 修复车道，JSON schema 明确携带 uncovered 数量与条目。

## C023 FR 注册表升级保留不可变历史 <!-- oracle:test:tests/registry.test.ts risk:high refs:specs/urtext/spec.md#C003 req:FR002,FR010 -->

旧 `.urtext/registry.sqlite` 通过加法迁移获得 FR 表、req 边和 grammar version；旧修订不改写，首次新语法扫描追加修订并重新执行 mandatory-req 校验。
```

**Rejected alternative — bind new FR behavior only to C001/C007/C008/C016:** those clauses mention older oracle/ref/status contracts and would not state `req`, `unknown_req`, FR hash propagation, coverage, or legacy migration precisely enough to dogfood the feature.

### `specs/distill/spec.md`: exact FR text to insert

```markdown
## FR001 维护者必须获得确定性、可复核且不冒充产品意图的代码事实

系统必须稳定清点源码、测试、入口与机器契约，把观察事实和已有规范声明明确分型，并覆盖每个观察到的文件或测试而不凭结构推断产品行为。

## FR002 维护者必须看到声明证据与观察仓库之间可行动的缺口

覆盖与校验必须指出不存在的声明目标及未被任何声明拥有的观察文件，并以具体路径呈现问题，不生成缺乏证据的完整度百分比。

## FR003 用户必须能从 CLI 发现并执行完整的 distill 工作流

CLI 帮助必须准确列出 discovery、coverage、validation、clustering、baseline 与 promotion 的命令边界，使这些能力可被直接操作而不是隐藏实现细节。

## FR004 从代码合成的规范候选必须在人类复核前保持非权威

自动合成只能产出分阶段候选，区分观察与推断并保留证据缺口；快速 promotion 只能导入当前、观察所得、低风险且可运行的候选，其他内容继续留在 staging。
```

| Clause | Add binding | Intent defended |
|---|---|---|
| C001 | `req:FR001` | deterministic facts manifest |
| C002 | `req:FR001` | observed vs declared separation |
| C003 | `req:FR002` | actionable coverage gaps |
| C004 | `req:FR002` | invalid evidence/oracle target rejection |
| C005 | `req:FR003` | CLI command-family documentation |
| C006 | `req:FR004` | review-only synthesis |
| C007 | `req:FR004` | constrained fast promotion |
| C008 | `req:FR001` | exhaustive structural domain inventory |
| C009 | `req:FR001` | exhaustive observed test baseline |

**Rejected alternative — reuse Urtext FR IDs via explicit cross-feature paths:** distill has its own user intent and should remain understandable as a self-contained feature unit; its existing `refs` already capture lower-level cross-feature dependency.

### `specs/loops/spec.md`: exact FR text to insert

```markdown
## FR001 自治 loop 的行为结论必须来自真实、受限且可复现的运行

任何 bug、修复或审计行为声称都必须记录实际命令与观察结果；复现要先于报告或修改，并用 timeout 与 shell 安全规则限制无人值守执行的破坏和卡死风险。

## FR002 未验证 worker 产物必须在隔离与集成边界重新证明

并行 worker 的声明和 diff 不得直接进入主干；产物必须隔离交付，并由集成者在新 trunk 上重新应用、重跑复现、完成组合测试和 unmapped 裁决后才能合入。

## FR003 loop 的事实源、攻击面与模型路由必须由人治理并吸收事故

愿景只引用单一权威文档，AREAS 边界和模型路由由人审定；每次事故都必须回写为带编号的协议规则，使自治机制从失败中形成持久约束。

## FR004 hunt 必须以透明轮换和分层模型系统覆盖真实攻击面

扫描按最久未覆盖领域轮换，finder 与 verifier 使用成本和能力匹配的不同模型，且每个 AREAS 条目必须落到真实源码文件和可验证符号。

## FR005 finding 流必须只保留边界明确、去重后的高信号缺陷

finding 类型必须限制在裁判正确性相关的封闭枚举中，并在归档前对现有 issue 去重，避免风格噪声、并行 backlog 或重复报告淹没修复能力。

## FR006 修复能力增长必须同步扩大覆盖且保持变更可归因、无越界

新增语法、oracle、linker 或检测能力时必须同 change 增加多用例测试；worker 只处理已分配 issue，并报告每个 hunk 的 clause 归因或 unmapped 理由。

## FR007 裁判系统必须被多视角、只读且有运行证据地持续审计

每个 sprint 必须从 drift、soundness、consistency、formal 四个视角并行审计；审计 agent 只返回结构化 findings，行为结论必须附实际 RUN，综合与归档由调用方完成。

## FR008 并行工作必须遵守不相交车道并串行处理热点

并行 worker 只能修改不相交模块，人工维护的热点文件必须串行，以降低补丁在集成接缝处相互覆盖或重复丢失的风险。
```

| Clause | Add binding | Intent defended |
|---|---|---|
| C101 | `req:FR001` | run result is referee |
| C102 | `req:FR002` | integration trust boundary |
| C103 | `req:FR003` | incident rule write-back |
| C104 | `req:FR003` | single source of truth |
| C105 | `req:FR001` | unattended shell safety |
| C201 | `req:FR001` | no repro, no report |
| C202 | `req:FR003` | human-owned AREAS map |
| C203 | `req:FR004` | least-recently-scanned rotation |
| C204 | `req:FR004` | cheap find, strong verify |
| C205 | `req:FR005` | closed finding taxonomy |
| C206 | `req:FR001` | timeout-wrapped reproduction |
| C207 | `req:FR005` | issue deduplication |
| C208 | `req:FR004` | AREAS anchored to real symbols |
| C301 | `req:FR001` | reproduce before changing code |
| C302 | `req:FR006` | coverage follows capability |
| C303 | `req:FR002,FR008` | isolated worker artifacts |
| C305 | `req:FR006` | no scope creep |
| C306 | `req:FR006` | provenance dogfood |
| C401 | `req:FR007` | four-lens audit |
| C402 | `req:FR007` | read-only audit workers |
| C403 | `req:FR001,FR007` | behavior claims require RUN |
| C501 | `req:FR002` | seven-step integration protocol |
| C502 | `req:FR008` | lane discipline |
| C503 | `req:FR002,FR006` | unmapped integration gate |
| C504 | `req:FR003` | human-owned model routing |

**Rejected alternative — one broad “loops must be safe” FR:** it would technically cover everything while erasing the distinct owner intents for empirical truth, integration trust, governance, hunt coverage, finding quality, change discipline, audit, and concurrency.

### Documentation evolution entry

Update `docs/SYNTAX.md` without renaming v0 or rewriting history:

1. Add a dated/versioned “Evolution: requirement layer (FR), 2026-07-26” entry immediately after the frozen-status note, stating this is an additive grammar evolution.
2. Add an FR grammar section with `/^#{1,6}\s+(FR\d+)\b\s*(.*)$/`, title+body semantics, and the oracle/risk prohibition.
3. Add required `req` to the clause anchor table with bare and explicit forms.
4. Add registry tables/hash/stale and uncovered status semantics.
5. Add error-table rows for `missing_requirement`, `malformed_req`, `oracle_on_requirement`, `risk_on_requirement`, `duplicate_requirement_id`, and `unknown_req`; distinguish indexing errors from check-stage errors.

**Rejected alternative — silently edit the v0 prose as though FR always existed:** line 3 explicitly freezes v0 and requires version evolution to be recorded (`docs/SYNTAX.md:1-4`).

## 9. Risks and open edge cases

### FR-only files and units

An FR-only non-`tasks.md` file is a valid ready clause-file revision. Its FRs appear uncovered until another live clause file in the same feature binds them. A feature with only FRs also retains the existing `clauselessUnits` warning (`src/scanner.ts:83-109`). Update that warning text from “spec prose binds no oracle” to “requirements/prose declare no executable clause” so it does not imply the FRs were ignored.

**Rejected alternative — make FR-only files `building`:** uncovered intent is explicitly a status concern, not an indexing error.

### FR headings in `tasks.md`

`tasks.md` is not a clause file and is parsed only by `parseTaskFile` (`src/scanner.ts:64-69`, `src/scanner.ts:111-116`). An `FR001` heading there is ordinary checklist prose and does not satisfy any req; a clause pointing to it receives `unknown_req`.

**Rejected alternative — teach the task parser to declare FRs:** it contradicts the pinned “any clause file except tasks.md” boundary and entangles intent with execution checklists.

### Duplicate IDs

Same-file duplicates are indexing errors; cross-file duplicates in one feature are check-stage `duplicate_requirement_id`. The same bare ID in different features is valid. Explicit paths remain available for cross-feature binding.

**Rejected alternative — require globally unique FR IDs:** feature-local IDs are part of the pinned bare-resolution contract, and global uniqueness would make independent specs coordinate numbering.

### Cross-feature and malformed paths

Bare refs never leave the source feature. Cross-feature refs must use the exact workspace-relative `path#FR<n>` form, matching current `refs` behavior; the parser checks only shape and the linker checks existence. No filesystem normalization, URL decoding, `..` cleanup, or case folding is introduced.

**Rejected alternative — normalize paths in only `req` parsing:** it would make `req` and `refs` grammars resolve superficially identical strings differently.

### Tombstoned or removed FRs

The latest tombstoned file contributes no live FR; inbound bindings become `unknown_req`, and coverage excludes its declarations. Removing an FR from a still-present file also records a changed requirement key, invalidates bound/downstream evidence, and creates `unknown_req` until bindings are repaired.

The current scanner does not call `tombstoneFile` for disappeared paths—only tests call that API (`src/registry.ts:297-316`; current usages are in `tests/registry.test.ts:76-95`). This feature defines correct linker behavior once a tombstone exists but does not silently broaden into a deletion-discovery rewrite.

**Rejected alternative — add registry-wide deletion discovery inside this feature:** it is a real pre-existing gap for clauses/tasks too and deserves a separate owner contract rather than an FR-only partial fix.

### Building revisions

“Live” continues to mean latest non-tombstoned, including `building`, because that is the linker's current definition (`src/linker.ts:53-65`). Broken current edits therefore cannot fall back to the last ready FR or clause. Coverage from malformed/ambiguous edges does not count, and check already fails.

**Rejected alternative — resolve reqs against the latest ready revision:** it would let a broken current target edit keep old bindings green and violate fail-closed current-snapshot semantics.

### Transaction and evidence invalidation boundaries

File reconciliation remains one database transaction. Workspace link validation and evidence invalidation remain the post-reconciliation scanner phase, matching today (`src/scanner.ts:120-125`). If the process dies between commit and propagation, the next unchanged scan currently has no changed-key event to replay.

Mitigation in this slice: wrap link validation plus propagation in an outer scanner transaction only if `ensureEvidenceLedger` and existing callers prove nested behavior safe; otherwise add a persisted `pending_invalidations` ledger keyed by source hash transition. The smaller initial implementation should add a crash-window test before claiming atomicity.

**Rejected alternative — assert the current two-phase flow is atomic:** the source shows separate registry transactions and a later linker call, so that claim would be false.

### Status consumers and WIP

The `/2` bump is a deliberate compatibility signal. CLI and UI use combined human count; uncovered FRs can push WIP over its provisional default of 10 (`src/status.ts:79-80`). They have no brief or decision action because choosing whether to add a clause, rewrite, or retire intent is human judgment.

**Rejected alternative — exclude uncovered FRs from WIP/counts:** then the headline would under-report the human attention that the pinned contract explicitly assigns to the human lane.

### Performance

The live graph currently executes per-live-revision clause/ref statements (`src/linker.ts:67-84`). Adding two more per-revision queries is acceptable for the surgical first slice, with the new lookup indexes. Capture a large synthetic workspace benchmark before replacing it with a multi-CTE query.

**Rejected alternative — redesign the whole linker around recursive SQL now:** stale BFS and impact already use typed in-memory graphs, and a broad query rewrite would increase regression surface without a stated scale target.

## Weaknesses I know about

1. The cross-file `duplicate_requirement_id` check is stricter than the pinned minimum. It protects deterministic bare resolution, but an opposing plan may reasonably allow duplicate IDs when every binding is explicit and report ambiguity only for bare refs.
2. The proposed FR groupings are editorial judgments. They are materially less tautological than one-FR-per-clause, but owners may split or merge them without changing the storage/parser design; that review must occur before implementation edits the specs.
3. The real code snippets were designed against strict TypeScript style but were not compiled, formatted, or tested because the planning task forbids those actions. In particular, the table-valued pragma parameter must be checked in implementation.
4. The existing evidence invalidation update is keyed only by `(spec_path, clause_id)` and stamps every non-invalidated historical evidence row, not just one revision (`src/linker.ts:151-159`). This plan reuses that pinned mechanism; it does not repair or reinterpret its historical granularity.
5. The current scanner has no automatic deleted-file reconciliation. Therefore a physically deleted FR file will become `unknown_req` only after some external path appends its tombstone; this is explicitly not solved here.
6. Registry reconciliation commits before stale propagation. A process crash in that gap can lose the one-shot `changedRequirements` signal on the next no-op scan. A persisted invalidation queue is more robust but adds schema and recovery complexity; implementation must either close this gap transactionally or document/test it rather than wave it away.
7. `grammar_version = 1` is a manual semantic migration marker. Future grammar changes must bump it deliberately; forgetting a bump recreates the unchanged-content bypass this design is intended to prevent.
8. Counting latest `building` declarations as live matches current linker behavior but can make status temporarily show uncovered FRs from a file that check already rejects. Filtering them would be prettier but would silently fall back from the current broken snapshot.
9. Historical pre-FR revisions are not reconstructed. They remain truthful records of what the old parser knew, but historical requirement coverage cannot be queried before the first version-1 revision.
10. The status `/2` bump is an intentional consumer break. Known CLI/UI/package tests are in the migration list, but unknown external exact decoders will need an upgrade path.
11. The four proposed C020–C023 clauses use aggregate test files as oracles. A single green file proves the suite passed, not which assertion defended which clause; finer test name/pattern references would improve evidence precision if the oracle runner supports them reliably.
12. The plan adds a minimal UI coverage table because hiding entries while counting them is misleading. If the owner interprets the brief's UI section as strictly “no UI work,” that is a small scope disagreement, not a pinned-contract correctness issue.
