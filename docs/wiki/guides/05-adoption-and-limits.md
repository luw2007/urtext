# Adoption and Limits

Urtext is designed to be adopted incrementally and abandoned honestly. This page
is about both — how to start with the smallest possible commitment, and the
conditions under which you should *not* use Urtext at all.

## Adopt incrementally

Urtext is git-native and serverless (principle P8): no daemon, no long-running
service, no workspace, no orchestration model. It does require Node.js 22+ and the
npm package (which builds native `better-sqlite3`):

- **`cd` into a repository you already have** and write one clause. You do not
  convert the whole project.
- **Specify only the load-bearing promises.** UI details can stay prose; the money
  path deserves clauses. Coverage grows with risk, not with completeness.
- **Every milestone stands alone.** The registry, linker, DWARF, gate, and unsafe
  lane each ship independent value — you can stop at any layer and what you have
  still works.

Urtext is also agent-agnostic. It does not orchestrate anything; it defines the
protocol "run the oracle and hand back evidence," which any AI coding agent
(Claude Code, Codex, and others) can satisfy. It consumes agents; it does not
replace them.

## The falsification condition

Urtext ships its own disproof, and you should know it before you commit. The
whole system rests on one wager:

> **The cost of writing an oracle for a clause is less than the cost of reviewing
> the resulting code line by line.**

If that inequality inverts, Urtext degrades into a bureaucratic test-writing
ritual — and the project's stated policy is to **stop expanding rather than add
features to rescue a failed assumption.** The built-in signal: every `verify`
reports the **share of `manual` oracles** for that run and prints a warning when it
exceeds 50%. Note the tool computes the *current run's* share only — it does not
track history or a "sustained" trend, and it enforces no stop; watching the trend
and honoring the stop policy is on you.

| Signal | What it means | The honest response |
|---|---|---|
| `manual share` > 50% on a run (watch the trend) | Most clauses aren't decidable; the bet may be failing | Stop expanding; do not add features to compensate |
| Green `verify` but you still distrust the output | The oracles are testing the wrong thing | Audit oracle coverage; the [meta-audit](../mechanisms/06-meta-audit-gate.md) exists for this |
| Clause-to-code ratio climbing abnormally | Early sign of spec bureaucracy | Review granularity; let more things be prose |

## When *not* to use Urtext

Urtext is deliberately narrow. Reach for something else when:

- **You need multi-agent orchestration, a merge queue, or fleet management.** That
  is not Urtext's job — tools like Gastown cover it. Urtext consumes agents, it
  does not coordinate them.
- **You want formal proofs.** An oracle is an *engineering* judgment (a test, a
  command, a threshold), not a theorem. If you need TLA+ or Dafny-grade guarantees,
  use TLA+ or Dafny.
- **You want a replacement for git or CI.** Urtext runs oracles through your
  existing tests and commands; it provides binding and attribution, not a new
  build system.
- **Your spec is stable and small and your team is disciplined.** If Spec Kit's
  conventions are working for you and drift is not a real problem, the enforcement
  layer is overhead you may not need. Urtext earns its keep where spec rot actually
  bites.
- **You need cloud collaboration or multi-tenant workflows.** v0 is a
  single-machine, single-repo closed loop by design. Team scenarios (comments,
  concurrent spec editing) are deliberately deferred until there is a seed user to
  answer them.

## The v0 boundary, stated plainly

Some capabilities are named but **not yet implemented** — do not plan around them
as if they exist:

- **`metric` oracles** fail explicitly in v0 rather than evaluating a threshold.
- **Visual and interaction oracles** (screenshot diffs against a design, demo
  replay) are a v1 extension of the `oracle` kind and `refs` target types. They
  are principle P7, not shipping code.
- **DWARF range re-anchoring** — following mapped lines when later edits move them —
  is a marked v0 simplification, not present yet.

Urtext's discipline is to name these boundaries rather than paper over them. A
tool that pretends unimplemented behavior exists is exactly the kind of silent
lie the whole system is built to prevent.
