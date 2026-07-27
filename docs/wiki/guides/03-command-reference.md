# Command Reference

Every Urtext command, its signature, its exit code, and what it writes. The
registry lives at `.urtext/registry.sqlite` under the current directory, and that
is the only state Urtext itself writes. Note that `test` and `cmd` oracles run
subprocesses (`npx vitest`, or your command) with your permissions and no sandbox —
those can touch the network or the filesystem; Urtext does not confine them.

The authoritative source is `urtext --help`; this page expands each entry.

## Validation and verification

### `urtext index`
Scan `specs/` and reconcile the clause registry. Unchanged content is a no-op;
changed content appends a revision. (Deletion tombstoning exists as a registry API
but is not wired into the scanner in v0, so a deleted file's last revision stays
live.) Most other commands run this scan first — the exceptions are `ack`,
`blame`, and `decisions`, which do not index. Exit 0.

### `urtext check [--diff]`
Index, then report errors. **Exit 1** on any `building` revision (a file with a
parse or validation error) or any unknown cross-file `ref`. With `--diff`, it
additionally fails on unmapped working-tree changes — a hand edit that answers to
no clause. This is the fail-closed gate on grammar and references. `--json`
emits the `urtext.check/1` envelope (valid JSON even on exit 1).

### `urtext verify [--incremental]`
Index and check, then run every clause's oracle and record append-only evidence.
**Exit 1** on a validation or link error (before any oracle runs) *or* on any
failing clause oracle. Reports pass-rate and manual-share:

```text
34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13% (8.4s)
```

With `--incremental`, verify reuses a prior passing, non-stale `test`-oracle
verdict when the workspace fingerprint (HEAD + tracked diff + untracked contents
+ runtime identity) is unchanged — a reused verdict **appends no new evidence
row**. Any git-visible change, a `fail`, an invalidated verdict, a non-`test`
oracle, or a clause whose revision is new re-executes. Without the flag every
runnable oracle re-runs as before; when reuse occurs the summary reports it
inline, e.g. `34 pass, 0 fail, 5 pending, 12 reused — pass rate 100%, manual
share 13% (4.7s)`.

## Operator queue and brief

### `urtext status [--json] [--wip-limit <n>]`
One item-keyed queue merging every pending obligation, split by who can act. The
**human lane** holds judgment items whose prerequisites are met — pending
high-risk reviews, undecided manual clauses, audit disagreements, unmapped
working-tree changes. The **agent lane** holds remediable prerequisites —
missing/failing evidence, stale clauses, unaudited evidence; a clause with any
agent-lane reason stays out of the human queue until those resolve. Each item
appears once, with a primary blocker, secondary reasons, and a suggested next
action. `--wip-limit` (default 10, provisional) warns when the human queue grows
past it — scrutiny degrades on large batches. `--json` emits the
`urtext.status/1` envelope. **Exit 1** when anything is pending.

### `urtext brief <spec-path>#<clause-id> | <file>:<line>[-<end>] [--json]`
The full adjudication context for one clause in one command: clause text and
anchors, mapped code content read from the working tree, the latest evidence
(content-addressed digest — an identical re-verify keeps the hash stable),
meta-audit state, the impact closure, and review/decision history. The last line
is the **brief-hash**: the freshness token that `review --approve` and a
high-risk `decide --pass` must quote via `--brief <hash>`. A clause on a
`building` revision or with unresolved refs gets **no approvable hash**
(fail-closed). A `<file>:<line>` target resolves through `blame` and briefs
every constraining clause. **Exit 1** when any requested brief is refused.

## Impact analysis

### `urtext impact <spec-path>#<clause-id>`
List the clauses and tasks affected if the named clause changes — the reverse
closure over the `refs` graph. Exit 0; prints an empty result when nothing depends
on the clause.

```text
$ urtext impact specs/urtext/spec.md#C004
Affected clauses (reverse closure):
  specs/urtext/spec.md#C008
  ...
Affected tasks:
  specs/urtext/tasks.md T003 oracle runner 与证据库 (cites C004)
```

### `urtext impact <spec-path>#FR<n>`
List every live clause whose `req:` uniquely resolves to the requirement, then
their reverse `refs` closure and the tasks citing any affected clause. The one
clause list marks every row `[direct]` or `[transitive]`. An existing but
uncovered FR prints `none` and exits 0; an undeclared or tombstoned FR prints a
clear error and exits 1.

```text
$ urtext impact specs/urtext/spec.md#FR013
Affected clauses (direct + reverse closure):
  [direct] specs/urtext/spec.md#C020
  ...
```

## Clause ↔ code mapping (DWARF)

### `urtext map <spec-path>#<clause-id> <file>:<start>-<end> [note…]`
Record a clause→code mapping, cross-verified against the real `git diff` at the
current HEAD. A claimed range that does not intersect the actual diff is rejected —
provenance trusts the diff, not the self-report.

### `urtext ack <file>:<start>-<end> <reason…>`
Acknowledge an intentionally unmapped change. The **reason is required** — an
acknowledgment without a rationale is refused. This is the explicit escape valve
for a hand edit you do not want to (or cannot) attribute to a clause.

### `urtext blame <file>:<line>`
List the clauses constraining a code line — the inverse of `map`. An unmapped line
reports honestly that nothing constrains it:

```text
$ urtext blame src/verifier.ts:1
No clause constrains src/verifier.ts:1.
```

## Meta-verification and adjudication

### `urtext audit --export | --import <file> | --run <claude|codex|traex|omp> [--model <model>] [--profile <profile>]`
The cross-model meta-verification protocol. `--export` writes the
evidence-coverage package (`urtext-meta-audit/v0`) for an external auditor and
`--import` reads back `agree`/`disagree` verdicts. `--run` automates the export,
selected headless auditor invocation, strict exact-coverage validation, and one
atomic import. The selected client runs in its documented no-tools/read-only mode;
missing clients, timeouts, non-zero exits, or malformed/incomplete output exit 2
without importing any verdict. A completed import exits 1 when coverage contains a
`disagree`.

`--model` chooses the auditor model. `--profile` selects an isolated local Codex or
OMP profile; Claude Code uses `--bare` and does not load a local profile. `--run`
records the selected client/model/profile as auditor identity, but cannot enforce
D3 different-preset separation because evidence does not record the implementation
preset. Selecting a different preset remains the operator's responsibility.
Each audit run invokes the external agent CLI end-to-end; large batches on slow
models take minutes. The runner enforces a wall-clock timeout, default 60 minutes,
overridable via `URTEXT_AUDIT_TIMEOUT_MS` (positive integer milliseconds); on
timeout the run is rejected and no verdict is imported.

### `urtext gate [--diff]`
Risk-tier adjudication with **additive** predicates. Every runnable clause needs
`evidence=pass ∧ meta-audit=agree ∧ not stale`; a high-risk clause *additionally*
needs a human `review --approve` at the current HEAD; a manual clause needs a human
`decide --pass` at the current HEAD instead of runnable evidence (and no
meta-audit). Everything else routes to a human. `--diff` also counts unmapped
changes; `--json` emits the `urtext.gate/1` envelope. An approved high-risk
clause is **re-routed to a human while the worktree is dirty** — uncommitted
edits cannot ride a clean-tree approval. **Exit 1** when any clause needs a
human. *v0 caveat:* the gate matches
evidence by clause id, not revision, so re-`verify` before you `gate` (see [the
gate](../mechanisms/06-meta-audit-gate.md)).

```text
overall: human
  · 39 clause(s) require human adjudication
```

## Human decisions (the ledger)

### `urtext review <spec-path>#<clause-id> --approve|--reject [--brief <hash>] [note…]`
Record a human code review for a high-risk clause (the unsafe lane). Binds the
current HEAD sha; if HEAD moves, the review is stale and must be redone.
**Approving requires a clean worktree and the current brief-hash** (from
`urtext brief`): uncommitted edits or a missing/stale hash fail closed
(`dirty_worktree` / `brief_required` / `brief_stale`). Rejecting needs neither —
it is the conservative direction. Rejects an unknown or non-high-risk clause, or
a git failure. Persists to the `reviews` table (history readback via
`urtext brief`).

### `urtext decide <spec-path>#<clause-id> --pass|--fail [--brief <hash>] [note…]`
Record a human decision for a `manual`-oracle clause. Also binds the HEAD sha and
lands in the `decisions` ledger. **Passing a `risk:high` manual clause requires a
clean worktree and the current brief-hash**, same as an approval; `--fail` and
low-risk decisions need neither. Rejects an unknown or non-manual clause, or a
git failure.

### `urtext decisions`
List the Decision ledger, newest first.

```text
$ urtext decisions
No decisions recorded.
```

### `urtext ui [--port <n>] [--no-open]`
Open the local operator UI. It starts an **ephemeral** foreground server on
`127.0.0.1` (random port unless `--port`), opens your browser (`--no-open` skips
it), and blocks until **Ctrl-C**. The console family is split into four pages:
`/` for the human queue and workspace summary, `/agent` for the agent queue and
audit controls, `/specs` for every live clause, and `/decisions` for decided
manual clauses at HEAD. Each list owns an independent `?page=N`; page 1 omits
the query. `URTEXT_UI_PAGE_SIZE` sets the positive-integer server page size
(default 20). It is internal server/UI configuration, not part of the public
`UiRenderConfig` package API.

Workspace-level unmapped detection remains visible on every console-family
page. The compact notice links back to `/`; exact `urtext map` / `urtext ack`
remediation appears once, in the corresponding paginated human-queue row. A
detection failure is a visible error, never an empty all-clear. Every clause
item links to `/brief`; the All Specs page includes clauses absent from both
queues. The brief keeps the exact text printed by `urtext brief` and adds risk,
evidence, mapped-code, dependency, impact, and real mapped-range Git diff state.

Pending manual clauses have pass/fail buttons. The browser fetches the current
brief-hash and posts through the same guarded `recordDecision` path as the CLI;
passing also requires a one-sentence ledger note. High-risk code review controls
remain on `/brief` and use the same clean-worktree, brief-hash, and HEAD guards
as `urtext review`. Audit controls are always present on `/agent` and disabled
with an explicit empty state when nothing is auditable. The UI never starts
nested `urtext` processes or parses CLI display text.

Every page has a skip link, `<header>`, `<nav aria-label="页面导航">`, and one
`<main>`. Guarded actions are labelled inline forms with `aria-live` output; the
UI never calls `prompt()` or `alert()`. Each mapping's Code Blame Diff is
collapsible: high-risk or short diffs open by default
(`URTEXT_UI_DIFF_OPEN_MAX_LINES`, default 80), and output truncates at
`URTEXT_UI_DIFF_DISPLAY_MAX_LINES` (default 2000). All three environment values
must be positive integers or the server fails fast. Every route validates the
loopback `Host`; writes also enforce per-session CSRF, same-origin, exact JSON
content type, and a request-body cap. Styling is one inline light/dark,
reduced-motion-aware stylesheet with no framework, build step, external
resource, or network request. This is an interactive-session process, not a
daemon; Ctrl-C exits 0.

## Codebase fact distillation

### `urtext distill discover`
Scan the workspace and write a deterministic observed-facts manifest to
`.urtext/distill/facts.json`. It records source files, tests, CLI entry points,
the current Git HEAD, and separately declared `Implementation Evidence` and test
oracle targets. It **does not modify canonical `specs/`** or infer product intent.

### `urtext distill coverage`
Report declared implementation-evidence paths that do not exist and observed
source/test files that are not declared by any feature. Unowned observations are
discovery work, not a failed claim of incomplete behavior; this command exits 0.

### `urtext distill validate`
Rebuild the facts manifest, then validate declared implementation evidence and
`oracle:test:` targets. **Exit 1** for missing paths. It verifies references, not
semantic equivalence between prose and code.

### `urtext distill cluster`
Write `.urtext/distill/domains.json`, an L0 inventory that assigns every observed
source, test, and machine-contract file to exactly one deterministic structural
domain bucket. Buckets reflect path structure, not product intent; fallback
`platform/<top-level>` buckets are explicit ownership rather than an inferred domain.
The command does not create or modify canonical specs.

### `urtext distill baseline [validate|run]`
Write `.urtext/distill/baseline.json`, grouping every observed test into a direct
executable command within its structural domain. The baseline only asserts that
existing tests are evidence at the recorded HEAD; it does not infer their product
meaning. `validate` checks exact-once test assignment, HEAD consistency, and command
presence. `run` executes those groups and writes `baseline-evidence.json`; source and
contract files in domains without tests remain explicit gaps.

### `urtext distill l2 [validate]`
Write one non-normative L2 intent-review draft per structural domain under
`.urtext/distill/l2-generated-intent-drafts/`. It records observed files, L1 test
groups, and deferred gaps for human review; it does not assert product behavior or
modify canonical specs. `validate` checks exact-once domain assignment, baseline
HEAD consistency, and that each generated draft is present.

### `urtext distill promote <draft> --target <feature> --confirm`
Promote a current staged draft after one feature-level acceptance. The command
requires a draft beneath `.urtext/distill/spec-drafts/`, a matching facts-manifest
HEAD, and valid declared evidence. It appends only `observed` candidates carrying
a low-risk runnable `test` or `cmd` oracle and no pending human-decision marker to
`<feature>/clauses.md`; inferred, manual, high-risk, unresolved-oracle, and
decision-required candidates remain in staging. It validates oracle references but
does not execute staged commands; canonical `urtext verify` executes promoted oracles.
It does not overwrite `spec.md`, create mappings, or record reviews, decisions, or audit verdicts.

## Exit-code summary

This table is a working guide, not an exhaustive spec (the CLI in `src/cli.ts` is
authoritative):

| Command | Exit 1 when |
|---|---|
| `check` | building revision, unknown ref; `--diff` also: unmapped change |
| `verify` | validation/link error before oracles, or any clause oracle fails |
| `status` | anything is pending in either lane |
| `brief` | bad target, or any requested brief is refused (building/link-broken revision, unknown clause) |
| `impact` | bad target format, or an undeclared/tombstoned FR |
| `audit --import` | current coverage contains a `disagree` |
| `gate` | any clause needs a human |
| `map` | unknown clause, bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `ack` | bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `review` | unknown or non-high-risk clause, bad arguments, git failure; `--approve` also: dirty worktree, missing/stale brief-hash |
| `decide` | unknown or non-manual clause, bad arguments, git failure; high-risk `--pass` also: dirty worktree, missing/stale brief-hash |
| `distill promote` | missing `--confirm`/target, invalid or stale draft, invalid distill declaration, duplicate target clause ID, or invalid path |
| `distill cluster` | filesystem write failure |
| `distill baseline validate` | stale/mismatched inventory, test assignment, or missing command |
| `distill baseline run` | any generated test group fails |

All other commands exit 0 on success.
