# Why Specs Must Be Decidable

This is the principle everything else in Urtext rests on, and it is deliberately
uncompromising:

> **A normative clause with no oracle is an authoring error.**

Not a weaker kind of requirement. Not a "we'll verify it later." An error — the
same category as a syntax error — that keeps the clause out of the executable
system entirely.

## Prose is free; clauses are bound

Urtext draws a hard line through your specification, and the line is the
difference between **a language and a document.**

- **Descriptive prose is free.** Explain context, motivation, background,
  tradeoffs — write as much as you like. None of it is constrained, none of it is
  checked, none of it enters the adjudication system.
- **A normative clause is bound.** The moment a sentence declares that the system
  *must* satisfy something, it has to bind an oracle — a check that decides pass
  or fail with evidence. A clause without one is recorded as a `building` revision
  and can never reach an executable (`ready`) state, so it never runs. (In v0 the
  `test`, `cmd`, and `diff-scope` oracles execute; `manual` is a human check that
  yields `pending`; `metric` is declared but not yet runnable — see [Clauses and
  Oracles](../mechanisms/01-clause-and-oracle.md).)

Syntactically, the distinction is explicit: a clause is a Markdown heading
carrying a `C<n>` id. **A heading without that id is ordinary prose** and is
bound by nothing. Only statements you deliberately promote to clauses enter the
system of judgment. You are never forced to specify everything — you are only
forced to make the things you *did* specify checkable.

## What "decidable" buys you

The instant a normative statement must carry an oracle, four failure modes of
conventional spec-driven development close at the source:

- **No uncheckable gates.** The grammar does not judge prose — you *can* write
  `## C001 It should be fast <!-- oracle:cmd:true -->` and it will index. What the
  grammar refuses is a *missing or invalid* oracle: a clause with no oracle never
  reaches `ready`. Turning "fast" into a real threshold (a `metric` expression like
  `p99 < 200ms`, or a `cmd`/`test` that measures it) is an authoring discipline the
  syntax pushes toward but does not enforce; a cheating oracle is what the
  [meta-audit](../mechanisms/06-meta-audit-gate.md) is for.
- **No self-scoring.** Completion is an aggregate of objective evidence — the
  pass-rate is green runnable clauses over *decided* runnable clauses — not a number
  an AI assigns to its own work.
- **No silent gaps.** A requirement declared as a clause with no oracle is not
  quietly deferred; it is loudly rejected as `missing_oracle` at authoring time.
- **Attribution to a clause, by hand.** When a check fails, `urtext blame` maps the
  failing line back to the clause that constrains it — a human lookup in v0, not
  yet an automatic report (see [DWARF](../mechanisms/05-dwarf-mapping.md)).

## The oracle is not the same as a test

A common misread: "so it's just TDD with extra steps." No. A test written by the
same agent that wrote the implementation is **same-source verification** — red or
green only proves the AI's understanding of the spec is *self-consistent*, not
that the criterion is *met*. Two models can agree on the same misreading.

An oracle is broader than a unit test, and the *intent* is an **independent
third-party ground truth** — a check that stands apart from both the spec's
phrasing and the implementation's choices. Urtext does not enforce that
independence: it records an oracle's kind and ref and reruns it, but it cannot know
who authored the test or whether it is truly independent. What the tool guarantees
is *objective and rerunnable* evidence; keeping the oracle genuinely independent is
an authoring discipline, backstopped (not replaced) by the meta-audit. Urtext
defines five oracle kinds (`test`, `cmd`, `metric`, `diff-scope`, `manual`), and
adversarial review is reserved for a *meta* layer that audits whether the
evidence truly covers the clause — never as a substitute for the evidence
itself. Those mechanisms are detailed in [Clauses and
Oracles](../mechanisms/01-clause-and-oracle.md) and [Meta-Audit and the
Gate](../mechanisms/06-meta-audit-gate.md).

## The load-bearing bet

Decidability is not free. Writing an oracle for a clause costs something, and
Urtext stakes its existence on a single wager:

> **The cost of writing an oracle for a clause is less than the cost of reviewing
> the resulting code line by line.**

If that inequality ever inverts, Urtext degrades into a bureaucratic
test-writing ritual — and it says so out loud. The system ships its own
falsification condition: the share of `manual` oracles is a health metric, and a
sustained majority means the bet has failed. A system that carries its own
disproof is engineering; one that cannot be disproven is faith. See [Adoption and
Limits](../guides/05-adoption-and-limits.md) for how that tripwire works.
