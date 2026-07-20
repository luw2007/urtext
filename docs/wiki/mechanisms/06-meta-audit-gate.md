# Meta-Audit and the Gate

Objective evidence answers "did the oracle pass?" It does not answer "does the
oracle actually test the right thing?" A test can be green and still cheat; a
`diff-scope` glob can be gamed; a `cmd` that exits zero can check nothing. The last
two mechanisms address those gaps: **meta-audit** re-reads the evidence, and the
**gate** narrows human attention to exactly what needs it.

## Meta-audit: a second read of the evidence

Urtext can export its JSON package (`urtext audit --export`) for an external
auditor, or invoke one selected local headless client with `urtext audit --run
<claude|codex|omp>`. In both forms, each decided piece of evidence includes the
clause meaning, oracle, and objective output; the auditor returns one
`agree` / `disagree` verdict per evidence id, which Urtext imports only after
complete, exact output validation.

The *intent* (DECISIONS D3) is that the auditor runs on a **different preset** from
the implementer — Codex audits when Claude implemented, and vice versa — so the
check changes the dimension, not just the model. Be clear about where that lives:

- **The different-preset requirement is an operator discipline, not an enforced
  property.** `audit --import` accepts any non-empty `auditor` string and only
  checks that the evidence id exists (`src/cli.ts`, `src/audit.ts`). Urtext records
  the auditor name you give it; it does not verify the auditor was a different
  model. Running the audit under a different preset is your responsibility.
- **It reads evidence, it does not re-run the implementation.** The verdict binds a
  specific `evidence_id`. Stale and pending evidence are not exported — there is
  nothing to audit. One v0 wrinkle: the package pairs each evidence row with the
  *latest ready* clause text and oracle by clause id, without matching revisions —
  so if you edited the clause after the evidence was recorded, the export can show
  newer prose beside older evidence. Re-`verify` before you audit to keep them
  aligned.

## Disagreement is counted, over the current coverage

`audit --import` exits non-zero when the resulting **coverage** contains a
`disagree`. Coverage is computed over the *latest, non-stale, non-pending*
evidence, taking the *latest* audit verdict per evidence id (`src/audit.ts`). The
practical consequence:

- A `disagree` on the current evidence → `import` exits 1. Disagreement is never
  silently swallowed.
- A `disagree` that has been superseded by a later `agree` on the same evidence,
  or that sits on evidence since invalidated by stale propagation, is not counted —
  it is no longer part of current coverage.

So the exit code reflects "does the current picture contain an unresolved
disagreement?", not "has any disagreement ever been recorded." One v0 wrinkle:
coverage groups evidence by clause id without re-joining the live clause set, so a
`disagree` on a clause you have since *deleted* can still keep `import` red until
that orphan evidence is invalidated.

## The gate: risk-tier adjudication

`urtext gate` walks every live clause and decides, per clause, whether it can
auto-pass or must go to a human. The predicates are **additive** — a clause
auto-passes only when *all* the conditions that apply to it hold (`src/gate.ts`):

- **Every runnable clause** needs `evidence=pass`, `not stale`, and a meta-audit
  `agree` (neither `disagree` nor `unaudited`). This applies to high-risk runnable
  clauses too — they are not exempt from the audit requirement.
- **A high-risk clause** additionally needs a human code-review `approve` at the
  current HEAD ([the unsafe lane](07-unsafe-lane.md)). Evidence alone never clears
  it.
- **A manual clause** (always `pending`) needs a human `pass` decision at the
  current HEAD instead of runnable evidence, and needs **no** meta-audit — its
  ground truth is the human decision.

Everything else — missing evidence, a failure, a `pending` without a decision, a
`disagree`, `unaudited` (for any runnable clause), stale, or a rejected/absent
review on a high-risk clause — routes to a human with the reason attached. `gate
--diff` additionally folds unmapped changes into the overall verdict. **If any
clause needs a human, the whole gate needs a human**, and it exits non-zero.

> **v0 limitation — evidence is matched by clause id, not revision.** The gate
> pairs each live clause with its *latest* evidence row by `(spec_path,
> clause_id)`, without checking that the evidence was produced against the current
> revision (`src/gate.ts`). So if you edit a clause's oracle and have not re-run
> `verify`, the gate can still read the *previous* revision's green evidence. It
> also adjudicates clauses whose current revision is `building`. Always `verify`
> before you `gate`; do not treat a stale-evidence auto-pass as a fresh one. This
> is a known v0 gap, not intended behavior.

A real run against this repository, mid-development:

```text
$ urtext gate
  ...
  ⊗ C014 记忆层：manual 子句人工裁决落 Decision ledger [high] → human
      · high-risk: needs human code review — `urtext review` (P5)
      · no meta-audit verdict

overall: human
  · 39 clause(s) require human adjudication
```

Every `⊗` carries its reason. Nothing is hidden behind a summary score.

## What this changes about "human in the loop"

The debate is usually framed as "should a human be in the loop or not?" The gate
reframes it: **the human is always the final authority, but the machine decides
*what triggers* them.** Low-risk, green, agreed, non-stale clauses pass
automatically. Human attention converges on the high-risk and the disputed — which
is the only way the [central bet](../concepts/03-why-decidable.md) can hold at
scale. The highest-stakes slice of that convergence gets its own workflow: [the
unsafe lane](07-unsafe-lane.md).
