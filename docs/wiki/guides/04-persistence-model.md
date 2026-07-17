# Persistence Model

Spec Kit poses a sharp question in its [spec-persistence
models](https://github.github.com/spec-kit/concepts/spec-persistence.html): after
requirements change, what happens to `spec.md`, `plan.md`, and `tasks.md`? It
names three answers — flow-back, flow-forward, living spec — and is careful to say
the choice is **"a team convention, not a CLI setting."**

Urtext gives a different answer to the same question: it makes the convention a
mechanism.

## The two questions, restated

Spec Kit separates a temporal question ("how long should the spec matter?") from a
mutation question ("what happens to the artifact set when requirements change?").
Urtext's stance on each:

- **Temporal.** The spec is the source of truth and outlives the implementation —
  the *spec-anchored* to *spec-as-source* end of the spectrum. Code is a
  projection you regenerate, not a co-equal artifact you hand-maintain.
- **Mutation.** Completed revisions are immutable history, but change *propagates*
  through the reference graph rather than forking a new directory. This is a
  deliberate blend of two of Spec Kit's three models.

## Where Urtext lands on the three models

| Spec Kit model | Its rule | Urtext's relationship |
|---|---|---|
| **Flow-back** | Edit any artifact, reconcile by hand | *Rejected.* Manual reconciliation is exactly the silent-drift failure Urtext exists to prevent |
| **Flow-forward** | Freeze completed artifacts; new directory for new requirements | *Adopted at the storage layer.* The [registry](../mechanisms/02-registry.md) never rewrites a historical revision — it appends |
| **Living spec** | Edit `spec.md` first; regenerate derived artifacts | *Adopted at the propagation layer.* Change a clause and [stale propagation](../mechanisms/04-linker-impact.md) invalidates dependent evidence |

Urtext is **flow-forward in how it stores** (immutable revision chains,
append-only evidence) and **living in how it propagates** (a `text_hash` change
ripples staleness through the reverse closure). You get the audit trail of
flow-forward without its duplication problem, and the consistency of living spec
without losing the history. (A tombstone-on-delete revision exists in the schema
but is not yet wired into the scanner — in v0, deleting a file leaves its last
revision live; see [the registry](../mechanisms/02-registry.md).)

## The decisive difference: enforcement

Every Spec Kit model shares one property — it is a convention the team agrees to
follow, with a named failure mode when they don't (silent drift, duplicate
context, lost rationale). Urtext removes the reliance on agreement:

- **You cannot silently edit *tracked* code and skip the spec.** `urtext check
  --diff` flags the unmapped hunk and exits non-zero
  ([enforcement](../concepts/05-source-of-truth-flip.md)) — with a v0 blind spot
  for brand-new untracked files.
- **You cannot let downstream evidence keep a stale green mark.** Changing a
  clause's *text* voids the dependent evidence automatically (an anchor-only edit
  does not — see [the registry](../mechanisms/02-registry.md)).
- **You cannot fabricate the spec→code link against an untouched file.** The
  claimed range must overlap a real `git diff` hunk
  ([DWARF](../mechanisms/05-dwarf-mapping.md)); this proves something in the file
  changed, not that the whole range changed or that it satisfies the clause.

Spec Kit is right that the *choice* of temporal stance is a team decision — and
Urtext makes that choice explicitly (spec-as-source). But *keeping the artifacts
honest to that choice* is not left to discipline. That is the one thing Urtext
refuses to make optional.

## What this means in practice

You do not pick a persistence model in Urtext — the registry and the linker
implement one. Your job is narrower and more honest: **when you change intent,
change the clause, and let the mechanism tell you what went stale.** When you
change code without changing intent, the gate makes you either flow it back or
acknowledge it. The convention is no longer something to remember; it is something
the tool enforces.
