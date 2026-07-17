# Urtext vs Spec-Driven Development

Urtext and [Spec Kit](https://github.github.io/spec-kit/) live in the same world.
Both believe the specification should define the *what* before the *how*, both
reject one-shot generation in favor of multi-step refinement, and both put
governance before code. If you have read Spec Kit's SDD overview, the philosophy
will feel familiar.

> Comparison pinned to the Spec Kit checkout at commit `c47f334` (2026-05-26). Its
> commands are namespaced `/speckit.*` (a spec/plan/tasks/implement workflow plus
> optional `analyze`/`clarify`/`checklist`). The flow-back / flow-forward / living
> persistence taxonomy is from Spec Kit's published concept docs
> (github.io); it is not present as a page in this checkout. Check the upstream repo
> for later changes.

The difference is not philosophy. It is **where the decision lives.**

## What they share

- **Intent before implementation.** Spec Kit: specifications become executable
  and generate the implementation. Urtext: humans maintain intent, AI maintains
  the projection. Same north star.
- **Multi-step, not one-shot.** Spec Kit refines through
  `/speckit.constitution → .specify → .clarify → .plan → .tasks → .analyze →
  .implement`. Urtext refines through `intent → clause → link → review →
  materialize → generate → oracle → adjudicate`.
- **Governance first.** Spec Kit's `/speckit.constitution` sets the meta-rules.
  Urtext's design principles (P1–P9) play the same role — except Urtext's
  constitution is itself compiled into checkable clauses under `specs/urtext/`.
- **Spec rot is the enemy.** Spec Kit's spec-persistence models exist precisely
  because requirements change and artifacts drift. Urtext's whole enforcement
  layer exists for the same reason.

## Where they diverge

| Dimension | Spec Kit / SDD | Urtext |
|---|---|---|
| **Are spec sentences decidable?** | `spec.md` is natural language; not mechanically checkable | **No oracle = a syntax error.** A clause can't reach `ready` without one |
| **Where does completion come from?** | `/speckit.analyze` runs an LLM-driven, read-only coverage and consistency report (advisory) | **Completion = objective evidence pass-rate.** The AI does not score |
| **How is spec rot prevented?** | Three *team conventions* (flow-back / flow-forward / living) — explicitly "not a CLI setting" | **Unmapped-change enforcement.** A hand edit with no clause exits non-zero |
| **Impact analysis** | `/speckit.analyze` — an LLM pass over the current spec/plan/tasks | A `refs` graph with stale propagation; `urtext impact` answers mechanically |
| **Failure attribution** | No spec↔code map; failures land at the code/test layer | **DWARF layer (v0):** `urtext blame` maps a code line back to its clause (a manual lookup; automatic attribution is the goal, not yet wired) |
| **Execution scope** | An agent-driven spec → plan → tasks → implement command workflow | Deliberately *not* orchestration, CI, or dashboards — just "run the oracle, return evidence" |
| **Self-proof** | Docs describe the flow | **Dogfood:** `specs/urtext/` describes Urtext in its own syntax; `urtext verify` proves it |

## The lifecycle, mapped

Spec Kit's command chain is a clean articulation of the SDD lifecycle. Urtext does
not replace it — it hardens the two links where SDD relies on discipline:

- `/speckit.analyze` produces a read-only report of coverage and consistency
  across `spec.md`, `plan.md`, and `tasks.md`, and *recommends* resolving critical
  findings before implementing — but it does not enforce a threshold or block
  `/speckit.implement`; the user may proceed. Urtext's **gate** is the enforced
  counterpart: it decides each clause on objective evidence (pass over decided
  runnable clauses, backed by evidence rows) plus meta-audit and review, and exits
  non-zero when any clause needs a human.
- `/speckit.implement` writes state back after each task. This is exactly where
  spec rot begins, and where Spec Kit hands the problem to a persistence
  convention. Urtext puts a **gate** there instead: an unmapped hunk must flow back
  to the spec or be explicitly acknowledged, or `urtext check --diff` fails.

## The one-sentence difference

> Spec Kit lets a team *agree* to keep the spec authoritative. Urtext uses an
> immutable registry and unmapped-change enforcement to make that authority a
> *gate* rather than a promise.

Every SDD article names the same three anti-patterns — vague gates, spec rot, and
mid-iteration drift — and prescribes templates, review norms, and cleanup
instructions to fight them. Those are all discipline-based, and discipline-based
solutions to spec rot have been repeatedly shown to fail. Urtext's contribution
is to replace each of the three with a mechanism:

| Anti-pattern | The discipline-based fix (shown to fail) | Urtext's mechanism |
|---|---|---|
| Vague gate ("we need it fast") | Templates and review norms | Enforced only so far as: no oracle = a syntax error that never reaches `ready`. Quantifying the phrasing and catching cheating oracles stay authoring + meta-audit concerns |
| Spec rot (no write-back after implementation) | "Thoroughly implement and delete the old files" | Unmapped-change enforcement |
| Drift during iteration | Manually sync historical docs | Linker stale propagation + `urtext impact` |

The mechanism that carries the heaviest weight — turning "keep the spec
authoritative" from a convention into an enforced flip — is the subject of the
[next concept](05-source-of-truth-flip.md).
