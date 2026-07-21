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

### `urtext verify`
Index and check, then run every clause's oracle and record append-only evidence.
**Exit 1** on a validation or link error (before any oracle runs) *or* on any
failing clause oracle. Reports pass-rate and manual-share:

```text
34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13%
```

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

### `urtext audit --export | --import <file> | --run <claude|codex|omp> [--model <model>] [--profile <profile>]`
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
Open the local operator console. Starts an **ephemeral** foreground server on
`127.0.0.1` (random port unless `--port`), opens your browser (`--no-open` skips
it), and blocks until **Ctrl-C**. The page renders the same two-lane queue as
`urtext status`, links every clause item to its brief (`/brief` wraps the same
text `urtext brief` prints), and gives pending manual clauses pass/fail buttons —
a click fetches the brief-hash and posts to the same guarded `recordDecision`
path as `urtext decide`, so a high-risk manual clause cannot be passed without
the current brief (C018) and the verdict lands in the `decisions` ledger
immediately. Clicking **pass** additionally prompts for a one-sentence reason,
recorded as the decision's ledger note and enforced on the ui write path —
one-click approval is where rubber-stamping lives; `fail` may omit it.
High-risk CODE review stays CLI-only: the panel shows the pending
item and the command, but code is the only reviewable fact (P5). This is an
interactive-session process — not a daemon (no fork, no pid file, no
auto-start), the same category as the editor `git rebase -i` spawns (VISION P8).
Hardening: loopback-only, per-session CSRF token, same-origin and
JSON-content-type checks, request-body cap. Exit 0 on Ctrl-C.

## Exit-code summary

This table is a working guide, not an exhaustive spec (the CLI in `src/cli.ts` is
authoritative):

| Command | Exit 1 when |
|---|---|
| `check` | building revision, unknown ref; `--diff` also: unmapped change |
| `verify` | validation/link error before oracles, or any clause oracle fails |
| `status` | anything is pending in either lane |
| `brief` | bad target, or any requested brief is refused (building/link-broken revision, unknown clause) |
| `audit --import` | current coverage contains a `disagree` |
| `gate` | any clause needs a human |
| `map` | unknown clause, bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `ack` | bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `review` | unknown or non-high-risk clause, bad arguments, git failure; `--approve` also: dirty worktree, missing/stale brief-hash |
| `decide` | unknown or non-manual clause, bad arguments, git failure; high-risk `--pass` also: dirty worktree, missing/stale brief-hash |

All other commands exit 0 on success.
