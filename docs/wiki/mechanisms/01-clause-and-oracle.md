# Clauses and Oracles

The language layer has exactly four primitives: **clause**, **oracle**, **refs**,
and **risk**. Everything else in Urtext is built on them. This page is the
authoritative tour of the v0 grammar; the formal reference is
[`docs/SYNTAX.md`](../../SYNTAX.md).

## A clause is a heading with an id

A clause is a Markdown heading carrying a `C<n>` id, followed by its body (up to
the next heading of any level). The metadata rides in an HTML-comment anchor so
the visible text stays clean GFM.

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:specs/billing/spec.md#C003 -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

Two rules do all the work:

- The heading matches `^#{1,6}\s+(C\d+)\b\s*(.*)$`. **A heading without a `C\d+`
  id is ordinary prose** — bound by nothing, checked by nothing. Only a statement
  you deliberately promote to a clause enters the system of judgment.
- Anchor metadata is `key:value`, space-separated, and **values may not contain
  spaces** (a v0 boundary). The visible heading stays readable.

A `refs` value is a workspace-relative path plus `#Cid`, matched literally with no
path normalization — so it must be written from the workspace root, e.g.
`specs/billing/spec.md#C003`, not `billing/spec.md#C003`.

## The anchor fields

| Field | Required | Values | Meaning |
|---|---|---|---|
| `oracle` | **yes** | `<kind>` or `<kind>:<ref>` | The check. **Absent → `missing_oracle` error** |
| `risk` | no | `low` (default) \| `high` | `high` forces a human code review in the gate |
| `refs` | no | comma-separated `path#Cid` | Cross-spec dependencies; the linker builds its graph from these |

`risk` is a single binary tier — `low` or `high`, nothing finer. The broader
notion of risk as a multi-dimensional cost model (latency, blast radius,
reversibility) is the design principle behind the tier ([assembly-to-C condition
5](../concepts/02-assembly-to-c.md)), not additional fields v0 stores.

## The five oracle kinds

| Kind | Ref shape | Verdict | v0 status |
|---|---|---|---|
| `test` | a test file or pattern | `npx vitest run <ref>` exits 0 | executable |
| `cmd` | an executable + `%20`-separated literal args | the process exits 0 | executable |
| `diff-scope` | a glob of paths the change may touch | no *tracked* changed file falls outside | executable |
| `manual` | optional; a human-check description | never runs → always `pending` | non-executable |
| `metric` | a probe expression (e.g. `p99<200ms`) | — | **not supported; fails explicitly** |

Two precise points the syntax invites you to misread:

- **`cmd` is not a shell.** It runs `spawnSync(command, args)` with no shell, so
  pipes, redirection, `&&`, globbing, and variable expansion do **not** work. The
  ref is one executable plus literal arguments split on `%20`. For real shell
  syntax, point `cmd` at a wrapper script.
- **`metric` is declared but not decidable in v0.** The parser accepts it, but the
  runner returns `fail` with "metric oracles are not supported in v0." It is a v1
  feature — an unimplemented check must never look green, so it fails loudly rather
  than skipping.

And one subtlety in `diff-scope`: it checks `git diff --name-only HEAD`, which
lists **tracked** changes only. A new, untracked out-of-scope file is invisible to
it and will not trip the oracle until it is added.

## Checklists bind tasks to clauses

A sibling `tasks.md` in the same feature directory carries the acceptance
checklist. It is a GFM task list with the same anchor convention, and `clauses`
is a multi-valued field:

```markdown
- [ ] T001 Implement the stacking guard <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->
    Reject an already-discounted item on the apply path.
```

- One task per line: `- [ ] T\d+ Title <!-- … -->`; indented prose is that task's
  prompt.
- **A checkbox line without a `T\d+` id is a `missing_file_id` error** (fail-closed).
- `clauses:` must resolve to clauses declared in the same feature directory; an
  unresolved id is an `unknown_clause` error.
- `gate:true` is **stored metadata** signaling that the task should get human
  approval. In v0 it is recorded (`human_gate`) but **not enforced** — no command
  reads it to block a task. Treat it as an authoring marker, not a runtime lock.

## Fail-closed error catalog

When parsing or validation produces any error, that file's revision stops at
`building` and never becomes executable. There is no partial acceptance. The main
codes:

| Code | Meaning |
|---|---|
| `missing_oracle` | a clause binds no oracle |
| `invalid_oracle_kind` | oracle kind is not one of the five |
| `invalid_risk` | risk is neither `low` nor `high` |
| `duplicate_clause_id` | a clause id repeats within a file |
| `malformed_anchor` / `malformed_ref` | an anchor token is not `key:value`, or a `refs` value is malformed |
| `missing_file_id` | a checkbox line lacks a `T\d+` id |
| `duplicate_file_id` | a task id repeats |
| `self_dependency` / `unknown_dependency` | the task dependency closure does not hold |
| `unknown_clause` / `malformed_clause_ref` | a task cites a missing or malformed clause id |
| `unknown_ref` | a clause `refs` points at a missing file or id (checked at `check` time) |

The authoritative catalog lives in the parsers (`src/clause-parser.ts`,
`src/task-parser.ts`); this table is a working subset. Its enforcement is [P1 —
why specs must be decidable](../concepts/03-why-decidable.md). Once clauses exist,
they need a place to live across revisions: [the registry](02-registry.md).
