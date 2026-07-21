# The Unsafe Lane

Some paths cannot be fully carried by a spec. Security boundaries, data
migrations, concurrency, the money path, irreversible deletes — on these, the
specification will always leave semantics on the table, and **code stays the only
reviewable fact.** Urtext does not pretend otherwise, the same way C never
pretended `inline asm` did not exist. This is [principle
P5](../concepts/02-assembly-to-c.md), and the unsafe lane is its workflow.

## Green evidence is not enough for high risk

A `risk:high` clause does **not** auto-pass even when all its evidence is green.
The [gate](06-meta-audit-gate.md) refuses it on principle: passing tests prove the
implementation is self-consistent with the spec's phrasing, but on a dangerous
path that is precisely not enough. The human must look at the code.

`urtext review <spec>#<clause> --approve|--reject [note]` records that human
code-level review:

```text
$ urtext review specs/payment/spec.md#C001 --approve reviewed refund path
approved specs/payment/spec.md#C001 @ 3f2a1c0 by luw2007
```

The same review is available from the `urtext ui` console: the `/brief` page
renders the mapped code and, when the clause is review-ready (high-risk, evidence
pass, meta-audit agree, not stale), approve/reject buttons. A click posts to the
same guarded `recordReview` path as the CLI, so the browser cannot bypass the
preconditions below — the clean-worktree, current-brief-hash, and HEAD-binding
checks live in `review.ts`, not in the page. Approving from the browser requires a
one-sentence reason, the same anti-rubber-stamp rule as a manual pass.

## The review is bound to a commit

The approval is not a permanent blessing. It binds the **HEAD sha at the moment of
review**, recorded in `reviews(spec_path, clause_id, commit_sha, decision,
reviewer, note)`. If HEAD moves, the review is stale and the clause must be
reviewed again.

Be precise about what the binding covers: it records `git rev-parse HEAD` and
nothing about the working tree. So the review is anchored to the **committed
baseline**, not a snapshot of uncommitted edits. Committing new work moves HEAD
and invalidates the review — but uncommitted edits made after approval leave HEAD
unchanged and do *not* invalidate it. The guarantee is "this approval was made
against commit X," not "the exact bytes reviewed are the exact bytes that ship."
The gate lets a high-risk clause through only when it sees an `approve` at the
current HEAD *and* every other condition holds; a `reject` or a missing review
keeps it `human`.

## Two ledgers, one memory layer

Reviews are not ephemeral console output — they persist in the `reviews` table. So
do the human adjudications of `manual` clauses, recorded by `urtext decide
<spec>#<clause> --pass|--fail` into a **separate** `decisions` table, also bound to
the HEAD sha. The two are distinct ledgers, and only the decisions ledger has a
CLI readback:

```text
$ urtext decisions
No decisions recorded.
```

(Empty here because this repository's high-risk clauses are proven by `test`
oracles, and its `manual` clauses have no standing human decision.) `urtext
decisions` lists the decisions table only; there is no `reviews`-listing command
in v0 — a review is consumed by the gate, not browsed. Together the two tables are
the seed of Urtext's memory layer: every place human judgment entered the system,
its verdict, actor, HEAD sha, and timestamp are retained — plus the reason, when
the reviewer supplied one (the note is optional).

## Why the dangerous path is not a deadlock

Before the unsafe lane, a high-risk clause with green evidence was stuck: the
system would not auto-pass it, but there was no workflow to move it forward. The
lane resolves that without weakening the principle. The dangerous path is not
auto-approved and it is not deadlocked — it flows through a *traceable* human
review bound to the committed HEAD baseline it was made against. That is the escape
hatch
the [assembly-to-C analogy](../concepts/02-assembly-to-c.md) requires: a marked,
first-class place where the abstraction steps aside and code is reviewed
directly, rather than the whole system collapsing when 5% of behavior refuses to
be specified.
