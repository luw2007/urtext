# Authoring Clauses

Writing clauses well is a craft, and Urtext is honest that the craft does not
fully transfer as a rulebook — how finely to slice a spec is partly taste. What
*does* transfer is a set of decisions you can make deliberately instead of by
reflex. This guide is those decisions.

> A note on honesty: whether this craft can be taught rather than felt is an
> [open question the project tracks](05-adoption-and-limits.md), not a solved one.
> Treat what follows as a decision tree, not a guarantee.

## Prose or clause?

The first and most important decision. **Not everything should be a clause.**

- Write **prose** for context, motivation, background, and anything a future
  reader needs to understand *why* — none of it is checked, and that is correct.
- Write a **clause** only for a normative statement: something the system *must*
  satisfy, where a violation is a defect you would want a red mark for.

The test: *if this were violated, would I want the build to fail?* If yes, it is a
clause and it must bind an oracle. If no, it is prose. Granularity scales with
risk — a money path deserves fine-grained clauses; a UI detail may deserve none.
Over-specifying is its own failure mode: it inflates the clause-to-code ratio and
turns Urtext into bureaucracy.

## Choosing the oracle kind

Once something is a clause, pick the strongest oracle you can actually write:

| If the requirement is… | Use | Example ref |
|---|---|---|
| a behavioral rule with input/output | `test` | `tests/coupon-stack.test.ts` |
| checkable by running a command | `cmd` | `scripts/check-migrations.sh` |
| a numeric threshold | `metric` (v1) | `p99<200ms` — *not executable in v0* |
| a boundary on what may change | `diff-scope` | `src/billing/**` |
| genuinely only human-judgeable | `manual` | a description of what to check |

Prefer `test` and `cmd` — they produce **objective, re-runnable** evidence.
(Independence is not something Urtext enforces — it records an oracle's kind and
ref, not who wrote it; keeping the check genuinely independent of the
implementation is your discipline, backstopped by the meta-audit.) Reach for
`manual` last, and know that its share is a tracked health metric: a spec that is
mostly `manual` is a spec that mostly isn't decidable.

## Avoid the cheating oracles

The failure mode meta-audit exists to catch, but which you should avoid at the
source:

- **`cmd:true`** — a command that always exits zero. Green, and checks nothing.
- **A `test` that asserts nothing** — it runs, it passes, it proves the code
  didn't crash and nothing more.
- **A `diff-scope` so wide it can never be violated** — `**` allows everything.

Each of these is formally green and semantically empty. The
[meta-audit](../mechanisms/06-meta-audit-gate.md) is the safety net — a
different-model auditor asks "does this evidence actually cover the clause?" — but
the net is a backstop, not a license. Write the oracle you would trust if someone
else wrote it.

## Set risk deliberately

`risk:low` is the default and it means "green evidence *plus* a meta-audit `agree`
can auto-pass" (see [the gate](../mechanisms/06-meta-audit-gate.md)). Reserve
`risk:high` for paths where code stays the only reviewable fact — security, money,
migrations, concurrency, irreversible operations. A `risk:high` clause will not
auto-pass on green evidence alone; it routes to a human review
([the unsafe lane](../mechanisms/07-unsafe-lane.md)). Marking everything `high`
defeats the convergence the [gate](../mechanisms/06-meta-audit-gate.md) is for;
marking a money path `low` hides a danger the abstraction is supposed to keep
visible.

## Use refs to make impact real

When a clause depends on another, declare it with a workspace-relative path:
`refs:specs/billing/spec.md#C003` (written from the repo root, not
`billing/spec.md#C003`). This is
not documentation — it is what lets `urtext impact` answer "what does changing
this touch?" mechanically, and what drives stale propagation when an upstream
clause's meaning changes. A dependency you leave implicit is impact analysis you
throw away.

## The rule of thumb

Write the fewest clauses that make the system's *load-bearing* promises
decidable. Let the risky paths pull granularity toward themselves, let the rest
stay prose, and bind every clause to the strongest oracle you would trust from a
stranger. When in doubt, ask the falsification question from [Adoption and
Limits](05-adoption-and-limits.md): is writing this oracle cheaper than reviewing
the code it guards? If not, it may not be worth a clause at all.
