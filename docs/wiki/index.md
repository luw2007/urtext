# Urtext Documentation

> **The ur-text of your system. Code is just an interpretation.**

In classical music publishing, an *Urtext* edition strips away generations of
editorial alterations to recover the composer's original intent — the single
authoritative source every performance answers to. Urtext applies the same
discipline to software built with AI coding agents: **humans maintain system
intent, AI maintains the code, and every normative clause binds a check that
decides — with evidence — whether the intent still holds.** In v0 those checks are
test runs, command exit codes, and diff-scope boundaries; some intents fall back
to a recorded human decision.

Most spec-driven tooling stops at "write a spec, then generate." Urtext starts
where that ends: a specification sentence that cannot be checked is an authoring
error, not a softer kind of truth.

## Read in three layers

The documentation mirrors the way Urtext itself is built — from *why* down to
*how* down to *do it now*.

### Concepts — why decidable specs are a paradigm shift

- [The Paradigm Shift](concepts/01-paradigm-shift.md) — your work object moves from code to system cognition.
- [Assembly to C](concepts/02-assembly-to-c.md) — the six conditions a real abstraction jump requires, and their AI-era counterparts.
- [Why Specs Must Be Decidable](concepts/03-why-decidable.md) — the line between a language and a document.
- [Urtext vs Spec-Driven Development](concepts/04-vs-spec-driven-dev.md) — what Spec Kit and its peers share, and the one thing they leave to discipline.
- [The Source-of-Truth Flip](concepts/05-source-of-truth-flip.md) — why spec rot is stopped by enforcement, not convention.
- [The Urtext Metaphor](concepts/06-metaphor.md) — the ur-text, the interpretation, and the tuning fork.

### Mechanisms — how the loop closes

- [Clauses and Oracles](mechanisms/01-clause-and-oracle.md) — the four primitives of the language layer.
- [The Registry](mechanisms/02-registry.md) — the immutable revision chain.
- [The Verifier](mechanisms/03-verifier.md) — oracles run, evidence lands, pass-rate aggregates.
- [The Linker](mechanisms/04-linker-impact.md) — the reference graph and stale propagation.
- [DWARF Mapping](mechanisms/05-dwarf-mapping.md) — clause↔code storage, manual `blame`, and unmapped-change enforcement.
- [Meta-Audit and the Gate](mechanisms/06-meta-audit-gate.md) — cross-model verification and risk-tier adjudication.
- [The Unsafe Lane](mechanisms/07-unsafe-lane.md) — where code stays the only reviewable fact.

### Guides — put it to work

- [Quickstart](guides/01-quickstart.md) — your first clause in ten minutes.
- [Authoring Clauses](guides/02-authoring-clauses.md) — the craft of granularity and oracle choice.
- [Command Reference](guides/03-command-reference.md) — all twelve commands, exit codes and evidence.
- [Persistence Model](guides/04-persistence-model.md) — Urtext's answer to the spec-persistence question.
- [Adoption and Limits](guides/05-adoption-and-limits.md) — how to start, and when *not* to reach for Urtext.

## Status

**v0 closed loop, self-hosted.** Urtext describes its own core behavior in
`specs/urtext/` and `urtext verify` proves it: clause and checklist parsers, an
immutable-revision registry, an oracle runner (`test` / `cmd` / `diff-scope` /
`manual`), append-only evidence, and pass-rate plus manual-share reporting. The
clause linker, DWARF mapping, cross-model meta-audit, the risk-tier gate, and the
unsafe review lane all ship in v0. Visual and interaction oracles are named for
v1 and not yet implemented — this documentation marks that boundary wherever it
matters.
