# Urtext Grammar (v0)

> Status: v0 is frozen. The implementation follows this document; breaking changes must record their version evolution here.
> Based on VISION P1 (an oracle is mandatory) and P6 (Markdown plus anchors; no invented format).

## Version evolution

| Version | Change | Rationale |
|---|---|---|
| v0 | Initial frozen grammar | VISION P1/P6 |
| v0.1 | **Requirement layer**: `FR\d+` heading declarations, mandatory clause `req`, requirement registry/coverage, and FR-driven stale propagation | Clauses were regression locks with no mechanical answer for which intent they defend or which intent has no defending clause. `revisions.grammar_version = 1` forces one additive reparse under the evolved grammar without rewriting v0 history. |

## File layout

```text
specs/<feature>/
  spec.md        behavioural clauses (any `*.md` except `tasks.md` may contain clauses)
  contract.md    optional interface-surface declarations
  tasks.md       acceptance checklist (tasks refer to clauses)

- Clause files and the checklist in one directory form a **feature unit**. A checklist's `clauses:` references resolve within that unit.
- Cross-file clause references use `refs:<workspace-relative-path>#<clause-id>`; requirement bindings use bare `req:FR<n>` inside a feature or explicit `req:<workspace-relative-path>#FR<n>`.

## Clauses

A clause is a Markdown heading carrying a `C\d+` ID plus the body that follows it, up to the next heading at any level.

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:billing/spec.md#C003 req:FR001 -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

Grammar rules:

- A heading matches `/^#{1,6}\s+(C\d+)\b\s*(.*)$/`. A heading without a `C\d+` ID is ordinary prose and unconstrained; only declared clauses enter the decision system.
- Metadata lives in an HTML-comment anchor. It contains space-separated `key:value` tokens; values cannot contain spaces. Visible text remains clean GFM.

## Requirements (FR)

A requirement is a Markdown heading carrying an `FR\d+` ID plus prose intent up to the next heading at any level.

```markdown
## FR001 Humans must be able to see uncovered intent

An operator needs a mechanical answer for whether every live intent has a defending clause.
```

- A heading matches `/^#{1,6}\s+(FR\d+)\b\s*(.*)$/`. FR headings may appear anywhere in a clause file; there is no grammar ordering restriction.
- FRs are intent, not decidable facts. `oracle:` produces `oracle_on_requirement`; `risk:` produces `risk_on_requirement`.
- FR IDs are unique within a file. A repeated ID is `duplicate_req_id`.
- Authoring recommendation: place an FR block before the first clause when migrating an existing file. Every heading terminates the preceding body, so inserting FRs between clauses can intentionally change the preceding clause `text_hash`.
- A bare clause binding `req:FR001` resolves across the same `specs/<feature>/` unit. `req:specs/other/spec.md#FR001` is an exact path binding. Duplicate declarations that make a bare binding non-unique produce check-stage `ambiguous_req`.
- `req` comma and empty-token handling mirrors `refs`: empty tokens from trailing/repeated commas are ignored, and a present value with no valid non-empty token is `malformed_req`. Unlike `refs`, exact duplicate `req` tokens are removed in first-seen order (persisted edges are unique either way).

### Anchor fields

| Field | Required | Values | Meaning |
|---|---|---|---|
| `oracle` | **yes** | `<kind>` or `<kind>:<ref>` | See the table below. Omission is `missing_oracle` (P1). |
| `risk` | no | `low` (default) \| `high` | `high` requires a human gate and code-level human review (unsafe semantics). |
| `refs` | no | comma-separated `path#Cid` | Cross-spec dependencies; the linker builds its graph and stale propagation from them. |
| `req` | **yes** | comma-separated `FR<n>` or `path#FR<n>` | Requirements this clause defends. Omission is `missing_requirement`; malformed present values are only `malformed_req`. |

| `dec` | no | comma-separated `D<n>` | Addressable decisions this clause depends on. |

### Decision references (`dec:`)

`dec:D4,D11` declares a normative dependency on entries in `docs/DECISIONS.md`. Each token must use the canonical, case-sensitive form `D[1-9][0-9]*`; a malformed token is `invalid_dec_ref` and a repeated token is `duplicate_dec_ref`.

### The five oracle kinds

| Kind | Reference form | Decision |
|---|---|---|
| `test` | test file/pattern | test passes |
| `cmd` | shell command; encode spaces as `%20` or use a wrapper script | exit code 0 |
| `metric` | probe expression, e.g. `p99<200ms` | **Not supported in v0: the runner returns `fail` (never a silent skip); planned for v1** |
| `diff-scope` | allowed path glob | the violating-file set is empty |
| `manual` | optional; or an explanation of the human check | human decision recorded in the Decision ledger; its share is a health metric (P9) |

## Decision ledger (`docs/DECISIONS.md`)

A machine-addressable decision heading is `## D<n> <title>`. A heading may carry `<!-- superseded-by:D<m> -->` to name its direct replacement. The ledger is append-only by convention, not enforced against repository history; superseding preserves an explicit evolution path without proving that history was not rewritten.

`dec:` links resolve at check time. A referenced ID absent from the ledger is `unknown_dec`; a referenced ID with no `docs/DECISIONS.md` is `missing_decisions_doc`. Referencing a directly superseded entry emits the non-fatal `superseded_dec` warning.

## Interface-surface contracts (`contract.md`)

An optional `specs/<feature>/contract.md` declares named file-level surfaces:

```markdown
## I001 CLI command surface <!-- surface:src/cli.ts -->
The command-line boundary remains coherent for callers.
```

- An interface heading is `## I<n> <title> <!-- surface:<path-or-glob>[,<path-or-glob>...] -->`. The body is free prose naming the boundary promise.
- Each surface is a repo-root-relative POSIX path. Absolute paths, backslashes, and `..` segments are invalid.
- `*` matches within one path segment; `**` matches zero or more complete path segments. Matching is against the whole path.
- A matching unmapped hunk **touches** an interface surface. It does not prove that a semantic interface was crossed; it only upgrades risk and prioritisation.
- A present but malformed contract is a fail-closed `check` and `gate` error. An absent `contract.md` declares no surfaces and preserves the prior unmapped-change behaviour.

## Checklists (`tasks.md`)

A GFM task list plus anchor metadata. `clauses` is multi-valued:

```markdown
- [ ] T001 Implement stacking guard <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->
    Reject an already-discounted item on the apply path.
    The second indented line is appended to the prompt.
```

- One task per line: `- [ ] T\d+ Title <!-- … -->`; indented prose is that task's prompt.
- `T00x` is a stable file-local ID; `depends` refers to another same-file `T00x`.
- A checkbox line without an ID is `missing_file_id` (fail closed).
- `clauses:` refers to clause IDs in the same feature unit; an unresolved reference is `unknown_clause`.
- `gate:true` is stored as `human_gate` metadata marking that the task should get human approval. In v0 it is recorded only and **not enforced**—no command reads it to block a task (an authoring marker, not a runtime lock).

| Field | Values |
|---|---|
| `role` | free-form execution hint, e.g. `coder` or `reviewer` |
| `depends` | comma-separated `T00x` IDs |
| `gate` | `true` enables a human gate |
| `clauses` | comma-separated `C\d+` IDs claimed by the task |

## Fail-closed errors

### Index-time errors

Any parse/index validation error leaves the file revision in `building`; it never becomes executable.

| Code | Meaning |
|---|---|
| `missing_oracle` | clause has no oracle |
| `invalid_oracle_kind` | oracle kind is not one of the five |
| `invalid_risk` | risk is not `low` or `high` |
| `duplicate_clause_id` | a clause ID repeats within a file |
| `malformed_anchor` | an anchor token is not `key:value` |
| `malformed_ref` | a clause `refs` value is not `<path>#C<n>` |
| `missing_requirement` | a clause omits the mandatory `req` field |
| `malformed_req` | a present clause `req` value has no valid `FR<n>` or `<path>#FR<n>` binding |
| `duplicate_req_id` | a requirement ID repeats within a file |
| `oracle_on_requirement` | a requirement declaration carries an `oracle` |
| `risk_on_requirement` | a requirement declaration carries a `risk` |
| `missing_file_id` | checkbox line has no `T00x` ID |
| `duplicate_file_id` | task ID repeats |
| `self_dependency` / `unknown_dependency` | task dependency closure is invalid |
| `unknown_clause` / `malformed_clause_ref` | a task references no clause in its feature unit, or a ref is not a `C<n>` ID |
| `invalid_dec_ref` | a clause `dec` token is not canonical `D<n>` |
| `duplicate_dec_ref` | a clause repeats a `dec` token |

### Check-time workspace errors

These errors are evaluated over all latest live revisions by `urtext check`. They do not rewrite the source revision status, but they fail the command with exit 1.

| Code | Meaning |
|---|---|
| `unknown_ref` | a clause `refs` a missing file or clause ID |
| `unknown_req` | a clause `req` target has no live requirement declaration |
| `ambiguous_req` | a bare `req` target has multiple live declarations in its feature unit |
| `missing_decisions_doc` | a clause has `dec` references but `docs/DECISIONS.md` is absent |
| `unknown_dec` | a clause `dec` target has no decision ledger entry |
| `missing_surface` | an interface declaration has no valid `surface` path |
| `duplicate_interface_id` | an interface ID repeats within a contract file |
| `invalid_surface_path` | an interface surface is not a repo-root-relative POSIX path |

### Check-time warnings

| Code | Meaning |
|---|---|
| `superseded_dec` | a clause references a decision with a direct `superseded-by` replacement |

## Registry

`urtext index` reconciles scan results into `.urtext/registry.sqlite` using immutable revision-chain semantics:

- Each file has a revision chain `(spec_path, revision)` and `content_hash = sha256:<hex>`.
- Clause-file content is a no-op only when both `content_hash` and `grammar_version` match. Historical rows remain version 0; the FR-capable parser appends version 1, forcing one reparse of byte-identical legacy files without rewriting history.
- Deleting a file appends a `tombstoned` revision with `content_hash NULL`; history is never rewritten.
- Each clause also stores `text_hash = sha256(heading + body)`; anchor-metadata changes are not text changes.
- Parsed `req` values are stored in `clauses.reqs` and normalized into `clause_reqs`; `to_spec = ''` marks a bare unit-local ID. Requirement declarations are stored in `requirements` on the same `(spec_path, revision)` chain, with `text_hash = sha256(title + body)`.
- `refs` edges are stored in `clause_refs` and versioned with revisions. The linker resolves references against all latest active workspace revisions after each scan. `unknown_ref` is therefore a whole-workspace `check` error rather than a single-file revision-state change.
- Changing an upstream clause `text_hash` invalidates existing evidence in the reverse dependency closure by writing
  the one logical invalidation stamp (`invalidated_at` + `invalidation_source`) in the same UPDATE. Evidence is never
  deleted; legacy NULL sources remain unknown and are never backfilled.
- Changing or removing an FR invalidates every clause whose raw `clause_reqs` edge targets its old key, then propagates
  through the ordinary `clause_refs` reverse closure. Reconciliation and invalidation commit in one SQLite transaction.
- `urtext status` reports live FR declarations with zero uniquely resolved live clause bindings in `uncoveredRequirements` and `counts.uncovered`. This report is orthogonal to the adjudication queues: it does not enter `items`, `counts.human`, WIP, or the status exit code.

## DWARF: clause↔code mapping (`urtext map` / `ack` / `blame` / `check --diff`)

- `clause_code_map` stores `(kind, spec_path, clause_id, file_path, line_start, line_end, commit_sha, note)`. `kind=clause` is a clause mapping; `kind=ack` is an explicit exemption.
- **Provenance trusts diffs, not assertions** (DECISIONS D4): claimed `map`/`ack` ranges must intersect a real hunk from `git diff --unified=0 HEAD`; the current HEAD SHA is persisted.
- `check --diff` attributes every working-tree hunk. It is attributed when it matches a mapping/ack from the **current HEAD**, or lies in `specs/<feature>/*.md` (spec write-back). Otherwise it is `unmapped` and exits 1.
- `blame <file>:<line>` looks up the clause mapping that constrains the line.
- v0 boundary: mappings are anchored by `(file, lines, commit_sha)` and later line drift is not re-anchored.

## Meta-verification and gate (`urtext audit` / `gate`)

- **Heterogeneous audit** (DECISIONS D3): Urtext never calls an LLM itself. `audit --export` emits a `urtext-meta-audit/v0` JSON package containing each decided clause's semantics, oracle, and objective evidence. An audit preset distinct from the implementation preset runs outside the process.
- Audit reads evidence and does not rerun implementation. A verdict (`agree`/`disagree`) binds a concrete `evidence_id` and is imported by `audit --import`. Stale and pending evidence are not exported.
- `audit_verdicts(evidence_id, auditor, verdict, note)` records results. `disagree` counts and makes import exit 1; it is never swallowed.
- **Gate** (VISION P4): `urtext gate` auto-passes only `risk=low ∧ evidence=pass ∧ audit=agree ∧ not stale`. Every other condition—high risk, missing evidence, failure, pending, disagreement, unaudited, or stale—routes to a human with reasons. `gate --diff` also counts unmapped changes. If any clause needs a human, the whole gate exits 1.
- **Unsafe lane** (VISION P5): a `risk:high` clause never auto-passes merely because evidence is green. `urtext review <spec>#<clause> --approve|--reject` records code review bound to HEAD; changing HEAD invalidates it. Only high-risk clauses use this lane. The gate passes one only with a current approval and all other conditions; rejection or missing review remains human-routed.
- **Decision ledger** (DESIGN §7): `manual` clauses remain pending until a person decides them. `urtext decide <spec>#<clause> --pass|--fail` records a HEAD-bound decision. Only manual clauses can be decided; runnable clauses are decided by objective evidence. A current pass decision lets the gate pass that manual clause. Manual clauses do not enter meta-audit because the human decision is their ground truth. `urtext decisions` lists the ledger newest first.

## v0 boundaries

- Anchor values cannot contain spaces; v1 may reconsider quoting and escaping.
- Design references (Figma), demo snapshots, and visual/interaction oracles belong to VISION P7. v1 may extend oracle kinds and `refs` target types without changing this grammar.
- Automatic re-anchoring for DWARF line drift is outside v0.
