# The Paradigm Shift

Software development is migrating through a sequence that is now visible in every
AI-assisted codebase:

```text
hand-coding → conversational AI → vibe coding → humans stop reviewing code line by line
```

Each step moves the same boundary: **what the human is actually responsible
for.** In hand-coding, you own every line. With conversational AI, you own the
prompt and skim the output. In vibe coding, you own the outcome and stop reading
the diff at all. The bottleneck follows the boundary — and it has already moved.
The hard part is no longer *writing* code. The hard part is *reviewing* it.

## The work object moves up

Urtext takes this migration seriously and names the new work object: **the
human's object of work is no longer code — it is cognition of the system.**

That cognition is not a single artifact. Urtext's vision (VISION §1, principle P7)
is that it spans four co-equal, first-class carriers, all part of one cognitive
unit, all cross-referencing each other:

- **Specs** describe behavior — what the system must do.
- **Designs** describe appearance — what it must look like.
- **Interaction demos** describe feel — how it must respond.
- **Checklists** describe acceptance — how you know it is done.

In shipping v0 the first and last are real — Urtext discovers Markdown clause
files and their sibling `tasks.md`, and `refs` link clauses to clauses. Design and
interaction carriers (and the visual/interaction oracles that would check them)
are the P7 vision, targeted for v1, not present today ([the
boundary](../guides/05-adoption-and-limits.md)). The paradigm claim is about where
the work is heading; the toolchain currently carries the behavioral and acceptance
halves.

The human maintains these. The AI maintains the **projection**: the code. Code
becomes fact the way assembly is fact — real, executable, but no longer the thing
a person reads to understand the system's intent.

## Why "better prompts" is not the answer

The tempting response to this migration is to write more precise instructions —
richer prompts, pseudocode, elaborate templates. Urtext rejects this outright.

Pseudocode and prompts live in the same category as code: they describe **how**
the machine should behave. Adding more of them only adds ambiguity, and they
throw away code's single advantage — that it actually runs. A genuine paradigm
shift does not improve the *precision* of the description. It changes the
*object* of the description: from "what the machine does" to "what the system
must satisfy."

That same move has already won three times in narrow domains — SQL for data,
Terraform for infrastructure, type systems for correctness. In each, humans
stopped writing the mechanism and started declaring the constraint, while a
deterministic engine produced and checked the mechanism underneath.

## What success looks like

When the work object has fully moved up, a human reviews exactly four things:

1. **Intent changes** — the spec diff.
2. **Impact** — what a change ripples into.
3. **Acceptance evidence** — did the checks pass.
4. **Disputes** — where models or evidence disagree.

Everything else — the routine code that satisfies an already-decided intent — is
no longer read line by line. Not because it is trusted blindly, but because
something else now decides whether it is correct. That "something else" is the
subject of the [next concept](02-assembly-to-c.md).
