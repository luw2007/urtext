# Urtext Project Brief

> Companion documents: [VISION](VISION.md) (principles), [DESIGN](DESIGN.md) (structure), [SYNTAX](SYNTAX.md) (grammar), [DECISIONS](DECISIONS.md) (record), and [ROADMAP](ROADMAP.md) (milestones and stop conditions). This is a decision brief for future maintainers and collaborators.

## Context

The development bottleneck is moving from writing code to reviewing it. Humans must manage cognition about a system—specifications, designs, demos, and acceptance checklists—while AI maintains the code projection. Existing spec-driven tools produce non-decidable sentences without impact analysis or spec↔code mapping; review tools remain at the code layer; multi-agent systems orchestrate generation but do not decide correctness.

The Assembly-to-C analogy requires decidable semantics, trusted translation, source-of-truth enforcement, bidirectional debug mapping, visible costs, and an escape hatch. LLMs provide translation but are stochastic, so determinism must move into verification.

## Objective

Make “humans maintain system intent; AI maintains code projection” an enforceable engineering fact. Success is measurable: review intent changes, impact, evidence, and disputes; bind every normative statement to an oracle; compute impacts mechanically; attribute failures to clauses; measure completion by evidence; and route humans only to high-risk, disputed, or unmapped work.

## Chosen approach

Markdown carries clauses: C-ID headings with `oracle`, `risk`, and `refs` anchors. An immutable revision registry stores them; an oracle runner writes append-only evidence; completion is aggregation rather than an AI score. The roadmap adds linker impact analysis, DWARF mappings, meta-verification, the unsafe lane, and multimodal oracles.

Rejected alternatives: cross-model diff review stays at the code layer; generic multi-agent workbenches are already native to model vendors; formal specification languages have steep cost and no translation bridge; pseudocode and prompt templates add ambiguity; discipline-only SDD cannot stop vague gates or spec rot.

## Risks and boundaries

1. The load-bearing assumption may fail: authoring oracles can cost more than code review. Manual-oracle share above 50% stops expansion.
2. Users can game checks with shallow oracles. Meta-verification examines evidence coverage, but is not a second proof system.
3. Clause granularity may be difficult to teach.
4. Model vendors may commoditize the category.
5. A seven-subsystem project may outrun a single maintainer.
6. Self-hosting evidence may not generalize to business repositories.

Known facts are recorded in the implementation, tests, and self-hosting specifications. Open questions include real oracle-writing cost, linker scale/noise, meta-verification value-to-cost, willingness to pay, multimodal reliability, and multi-person collaboration. The project response is observability: each important claim should live as a clause, so a broken claim turns into a red clause—or a newly known unknown.
