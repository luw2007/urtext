# Urtext Grammar (v0)

> Status: v0 is frozen. The implementation follows this document; breaking changes must record their version evolution here.
> Based on VISION P1 (an oracle is mandatory) and P6 (Markdown plus anchors; no invented format).

## File layout

```text
specs/<feature>/
  spec.md        behavioural clauses (any `*.md` except `tasks.md` may contain clauses)
  tasks.md       acceptance checklist (tasks refer to clauses)
```

- Clause files and the checklist in one directory form a **feature unit**. A checklist's `clauses:` references resolve within that unit.
- Cross-file references use `refs:<workspace-relative-path>#<clause-id>`.

## Clauses

A clause is a Markdown heading carrying a `C\d+` ID plus the body that follows it, up to the next heading at any level.

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:billing/spec.md#C003 -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

Grammar rules:

- A heading matches `/^#{1,6}\s+(C\d+)\b\s*(.*)$/`. A heading without a `C\d+` ID is ordinary prose and unconstrained; only declared clauses enter the decision system.
- Metadata lives in an HTML-comment anchor. It contains space-separated `key:value` tokens; values cannot contain spaces. Visible text remains clean GFM.

### Anchor fields

| Field | Required | Values | Meaning |
|---|---|---|---|
| `oracle` | **yes** | `<kind>` or `<kind>:<ref>` | See the table below. Omission is `missing_oracle` (P1). |
| `risk` | no | `low` (default) \| `high` | `high` requires a human gate and code-level human review (unsafe semantics). |
| `refs` | no | comma-separated `path#Cid` | Cross-spec dependencies; the linker builds its graph and stale propagation from them. |

### The five oracle kinds

| Kind | Reference form | Decision |
|---|---|---|
| `test` | test file/pattern | test passes |
| `cmd` | shell command; encode spaces as `%20` or use a wrapper script | exit code 0 |
| `metric` | probe expression, e.g. `p99<200ms` | **Not supported in v0: the runner returns `fail` (never a silent skip); planned for v1** |
| `diff-scope` | allowed path glob | the violating-file set is empty |
| `manual` | optional; or an explanation of the human check | human decision recorded in the Decision ledger; its share is a health metric (P9) |

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

Any parse or validation error leaves the file revision in `building`; it never becomes executable.

| Code | Meaning |
|---|---|
| `missing_oracle` | clause has no oracle |
| `invalid_oracle_kind` | oracle kind is not one of the five |
| `invalid_risk` | risk is not `low` or `high` |
| `duplicate_clause_id` | a clause ID repeats within a file |
| `malformed_anchor` | an anchor token is not `key:value` |
| `malformed_ref` | a clause `refs` value is not `<path>#C<n>` |
| `missing_file_id` | checkbox line has no `T00x` ID |
| `duplicate_file_id` | task ID repeats |
| `self_dependency` / `unknown_dependency` | task dependency closure is invalid |
| `unknown_clause` / `malformed_clause_ref` | a task references no clause in its feature unit, or a ref is not a `C<n>` ID |
| `unknown_ref` | a clause `refs` a missing file or ID; validated during `check` |

## Registry

`urtext index` reconciles scan results into `.urtext/registry.sqlite` using immutable revision-chain semantics:

- Each file has a revision chain `(spec_path, revision)` and `content_hash = sha256:<hex>`.
- Unchanged content is a no-op; changed content appends a new `ready` or `building` revision.
- Deleting a file appends a `tombstoned` revision with `content_hash NULL`; history is never rewritten.
- Each clause also stores `text_hash = sha256(heading + body)`; anchor-metadata changes are not text changes.
- `refs` edges are stored in `clause_refs` and versioned with revisions. The linker resolves references against all latest active workspace revisions after each scan. `unknown_ref` is therefore a whole-workspace `check` error rather than a single-file revision-state change.
- Changing an upstream clause `text_hash` invalidates existing evidence in the reverse dependency closure by setting `invalidated_at`. Evidence is never deleted.

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
