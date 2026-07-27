# Urtext Requirement Layer (FR) — Owner Contract Brief

## Background (why)

Urtext today enforces clause→oracle→evidence (P1) and code→clause attribution (P3), but nothing grounds clauses upward: there is NO requirement layer. Clauses in `specs/urtext/spec.md` (C001–C019+) are regression locks on the implementation; no mechanism answers "which requirement does this clause defend" or "which requirement has zero clauses". Requirement→spec drift currently relies on discipline — the exact failure mode Urtext's own docs (docs/zh-CN/wiki/concepts/05-source-of-truth-flip.md) argue is structurally doomed. This feature mechanizes the foundation.

## Goal

Make requirements (FR) first-class registry citizens and enforce clause→FR traceability, symmetric with P1's "clause without oracle = error".

## Pinned contract (owner decisions — NOT up for debate)

1. **FR declaration grammar**: an FR is a Markdown heading carrying an `FR\d+` ID in any clause file (`specs/<feature>/*.md` except `tasks.md`), body = prose intent, e.g.
   `## FR001 Humans must be able to see uncovered intent <!-- -->`
   FRs are intent, NOT decidable: an FR carrying an `oracle:` field is a fail-closed indexing error (`oracle_on_requirement`). `risk:` on FR is also an error.
2. **Clause anchor gains `req:` field**: comma-separated values; bare `FR\d+` resolves within the same feature unit; `path#FR\d+` is cross-file (mirrors `refs` grammar exactly). Malformed value → `malformed_req` (fail-closed).
3. **Enforcement is fail-closed at indexing**: a normative clause (`C\d+`) without at least one `req:` binding → `missing_requirement`, revision stays `building`. Symmetric with `missing_oracle`. NO config flag, NO warning mode.
4. **Dangling req is a check-stage workspace error**: `unknown_req` mirrors `unknown_ref` semantics (validated by `urtext check` over latest live revisions, exit 1).
5. **FR text change propagates stale**: FR `text_hash` (title+body) change marks all bound clauses stale via the existing reverse-closure/`invalidated_at` mechanism (reuse linker machinery; storage design up to you).
6. **Coverage report**: `urtext status` gains an uncovered-FR section — live FRs with zero live bound clauses. This is human-lane information (uncovered intent), not agent-fixable.
7. **Dogfood migration is IN SCOPE**: `specs/urtext/spec.md` (and any other spec file with clauses, check `specs/distill/`, `specs/loops/`) must gain FR declarations and every clause a `req:` binding, or the repo breaks its own indexing — the deliverable includes the migration and a green `urtext check` + full test suite.
8. **SYNTAX.md is frozen-with-evolution-log**: the grammar doc must record this as a version evolution entry, plus update field tables and error tables.

## Key code map (read these before planning)

- `src/anchor.ts` — anchor tokenizer (key:value pairs)
- `src/clause-parser.ts` — CLAUSE_LINE regex `/^(#{1,6})\s+(C\d+)\b\s*(.*)$/`, parseOracle, parseRefs, error codes
- `src/registry.ts` — REGISTRY_SCHEMA (lines ~58-115), indexClauseFile revision-chain reconciliation, text_hash
- `src/linker.ts` — liveGraph, linkWorkspace (`unknown_ref`), propagateStale (reverse closure → `invalidated_at`), impact
- `src/status.ts` — buildStatus, StatusItem lanes/reasons
- `src/cli.ts` — command wiring
- `src/scanner.ts` — file discovery
- `docs/SYNTAX.md` — grammar contract
- Tests: `tests/clause-parser.test.ts`, `tests/registry.test.ts`, `tests/linker.test.ts`, `tests/status.test.ts`

## Deliverable of the PLANNING phase

A technical plan **including core code** (real TypeScript diffs/snippets for the parser, registry schema migration, linker validation, stale propagation, status section — not pseudocode), covering:

1. Data model: where FR declarations and req edges live in SQLite; schema migration strategy for existing `.urtext/registry.sqlite` chains (append-only history must survive).
2. Parser changes: FR heading recognition, req parsing, new error codes; exact regex and type changes.
3. Registry reconciliation: FR text_hash, revision semantics for FRs (same chain? separate table?), fail-closed paths.
4. Linker: unknown_req validation, FR→clause stale propagation.
5. Status: uncovered-FR report shape.
6. UI (`src/ui/`) minimal impact statement — what breaks, what's deferred.
7. Test plan: which existing tests change, which new tests defend the new contract.
8. Dogfood migration: actual FR text drafts for specs/urtext/spec.md and the req bindings per clause.
9. Risks and open edge cases (e.g. FR-only file, FR in tasks.md, duplicate FR id, FR referenced across features, tombstoned FR).

## Constraints

- Match existing code style exactly (no reformat, no drive-by edits).
- No new dependencies. Node 22 + better-sqlite3 + TypeScript strict.
- Surgical: every changed line traces to this feature.
- Do NOT run formatters/linters/full test suites during planning.
