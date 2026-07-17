# Assembly to C

Everyone reaches for the same analogy: AI raises the abstraction level the way C
raised it above assembly. The analogy is right, but the usual telling is wrong.
C did not win because it was "higher level." It won because **six things happened
at once.** Miss any one and the abstraction leaks until it collapses back to the
layer below.

Urtext's design answers each condition in the AI era. The authoritative
[VISION](../../VISION.md) formalizes **four** load-bearing conditions; this page
adds two further conditions ([DECISIONS D5](../../DECISIONS.md)) that the founding
discussion recorded as necessary but secondary — six in total.

## The four load-bearing conditions (VISION §2)

| # | Assembly → C | The AI-era rupture | Urtext's answer |
|---|---|---|---|
| 1 | The target layer (the ISA) had formalized semantics first | The source language — natural-language spec — is undecidable | A normative statement must bind an oracle; unverifiable means wrong |
| 2 | The compiler was deterministic; trust was established once | LLMs are stochastic: one spec produces different code every time | **Determinism moves from the translator into the verifier** — a generate → verify → repair loop |
| 3 | The source-of-truth flipped: hand-editing compiler output became taboo | Code is still hand-edited and never flows back to the spec → spec rot | Unmapped-change enforcement: a hand edit must flow back or be explicitly acknowledged |
| 4 | DWARF stitched the two layers bidirectionally | Failures report a stack frame, forcing the human back down into code | The design goal: cognition ↔ code ↔ evidence mapped both ways so a failure attributes to a clause. v0 ships clause↔code storage plus a manual `blame`; automatic failure-to-clause attribution is not yet wired ([DWARF](../mechanisms/05-dwarf-mapping.md)) |

The pivotal one is **#2.** The LLM fills the "translator" role that the compiler
used to fill — but unlike the compiler, it is random. So the determinism that
made the whole abstraction trustworthy cannot live in the translator anymore. It
has to be reconstructed somewhere, and the only place left is the **verifier.**
Every existing spec tool is missing exactly this half.

## The two supporting conditions (DECISIONS D5)

Two more conditions are less famous but just as necessary — an abstraction that
skips them still leaks.

**5. The abstraction machine preserves a cost model.** C hides registers but
keeps memory and pointer costs visible; you can still reason about performance.
Urtext's counterpart: **risk is a first-class property of a clause.** The design
principle is that latency, blast radius, and reversibility stay visible rather than
buried. v0 encodes this as a single binary tier — `risk:low` or `risk:high` — not
as separate annotated dimensions; the finer cost model is the principle behind the
tier, not fields the grammar stores today. An abstraction that hid "how dangerous
is this change" would be worse than useless.

**6. There is an escape hatch.** `inline asm` and `volatile` exist because ~5% of
cases need the abstraction to step aside. Urtext's counterpart: **`risk:high` and
the unsafe lane.** Urtext does not pretend every behavior can be specified — just
as C never pretended inline assembly did not exist. On the dangerous paths, code
stays the only reviewable fact and drops back to human code-level review.

## The negative result

The same discussion that produced these six conditions produced one firm
negative: **pseudocode is never the answer.** It belongs to the same "how"
category as code, it only adds ambiguity, and it discards code's one virtue —
executability. Changing paradigms means changing the *object* of description
("what must be satisfied"), not the *precision* of the description.

With the six conditions on the table, the sharpest one — that a spec sentence
must be *decidable* — deserves its own treatment. That is the [next
concept](03-why-decidable.md).
