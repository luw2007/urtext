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
no clause. This is the fail-closed gate on grammar and references.

### `urtext verify`
Index and check, then run every clause's oracle and record append-only evidence.
**Exit 1** on a validation or link error (before any oracle runs) *or* on any
failing clause oracle. Reports pass-rate and manual-share:

```text
34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13%
```

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

### `urtext audit --export | --import <file>`
The cross-model meta-verification protocol. `--export` writes the
evidence-coverage package (`urtext-meta-audit/v0`) for an auditor you run on a
different preset (the different-preset requirement is operator discipline — the
import accepts any `auditor` name). `--import` reads back its `agree`/`disagree`
verdicts. **Exit 1** when the resulting coverage — the latest verdict over the
latest non-stale, non-pending evidence — contains a `disagree`. A disagreement
superseded by a later `agree`, or on since-invalidated evidence, is not counted.

### `urtext gate [--diff]`
Risk-tier adjudication with **additive** predicates. Every runnable clause needs
`evidence=pass ∧ meta-audit=agree ∧ not stale`; a high-risk clause *additionally*
needs a human `review --approve` at the current HEAD; a manual clause needs a human
`decide --pass` at the current HEAD instead of runnable evidence (and no
meta-audit). Everything else routes to a human. `--diff` also counts unmapped
changes. **Exit 1** when any clause needs a human. *v0 caveat:* the gate matches
evidence by clause id, not revision, so re-`verify` before you `gate` (see [the
gate](../mechanisms/06-meta-audit-gate.md)).

```text
overall: human
  · 39 clause(s) require human adjudication
```

## Human decisions (the ledger)

### `urtext review <spec-path>#<clause-id> --approve|--reject [note…]`
Record a human code review for a high-risk clause (the unsafe lane). Binds the
current HEAD sha; if HEAD moves, the review is stale and must be redone. Rejects an
unknown or non-high-risk clause, or a git failure. Persists to the `reviews` table
(no CLI readback in v0 — the gate consumes it).

### `urtext decide <spec-path>#<clause-id> --pass|--fail [note…]`
Record a human decision for a `manual`-oracle clause. Also binds the HEAD sha and
lands in the `decisions` ledger. Rejects an unknown or non-manual clause, or a git
failure.

### `urtext decisions`
List the Decision ledger, newest first.

```text
$ urtext decisions
No decisions recorded.
```

## Exit-code summary

This table is a working guide, not an exhaustive spec (the CLI in `src/cli.ts` is
authoritative):

| Command | Exit 1 when |
|---|---|
| `check` | building revision, unknown ref; `--diff` also: unmapped change |
| `verify` | validation/link error before oracles, or any clause oracle fails |
| `audit --import` | current coverage contains a `disagree` |
| `gate` | any clause needs a human |
| `map` | unknown clause, bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `ack` | bad arguments, git failure, or a range that does not overlap the current `git diff` |
| `review` | unknown or non-high-risk clause, bad arguments, or git failure |
| `decide` | unknown or non-manual clause, bad arguments, or git failure |

All other commands exit 0 on success.
