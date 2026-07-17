# Roadmap (Every Milestone Is Independently Mergeable and Valuable)

> Rule: the system remains usable at the end of every milestone. A later milestone is never borrowed as a prerequisite for an earlier one.
> Milestone acceptance means every clause added in that milestone is green in `specs/urtext/`.

## M1 Verifier — complete

Clause/checklist grammar, immutable revision-chain registry, oracle runner (`test` / `cmd` / `diff-scope` / `manual`), append-only evidence, `index/check/verify` CLI, and the self-hosting feature unit.

Acceptance achieved: `urtext verify` produced 5 pass / 1 pending-manual / exit 0 for this repository. Negative paths—an oracle-less clause and a failing oracle—each exited 1.

## M2 Linker: impact analysis — complete

- `refs` builds a versioned clause-reference graph (`clause_refs`); cross-file resolution and `unknown_ref` fail closed during whole-workspace `check`.
- Clause `text_hash` changes propagate stale state through the reverse closure; stale evidence receives `invalidated_at`.
- `urtext impact <spec-path>#<clause-id>` mechanically lists affected clauses and tasks.

Acceptance achieved: C007/C008 and `tests/linker.test.ts` are green; the self-hosting unit had 8 clauses, 7 pass and 1 pending-manual. Its independent value is mechanical impact analysis for a spec change.

## M3 DWARF: clause↔code↔evidence — complete

- `clause_code_map` persists mappings (`map`) and explicit exemptions (`ack`); a range is stored only after intersection with the real contemporaneous `git diff` (provenance trusts diffs, not LLM claims; DECISIONS D4).
- `urtext blame <file>:<line>` maps a code line back to its constraining clause.
- `urtext check --diff` rejects hunks not attributable to a mapping, acknowledgement, or spec write-back.

Acceptance achieved: C009/C010 and `tests/dwarf.test.ts` are green. The source-of-truth flip now has enforcement and failures can be attributed to clauses.

## M4 Meta-verification and automatic pass — complete

- Cross-model evidence-coverage audit: `audit --export` emits decided evidence; an external heterogeneous-preset agent returns `agree`/`disagree`; `audit --import` binds verdicts to `evidence_id` without rerunning evidence (DECISIONS D3).
- Risk-tier `urtext gate`: only `low + evidence=pass + audit=agree + not stale` passes automatically. High risk, failure, pending, disagreement, unaudited, stale, or unmapped work routes to a human with reasons.

Acceptance achieved: C011/C012 and `tests/gate.test.ts` are green. Human attention contracts to high-risk and disputed work.

## M5a Unsafe lane — complete

- `risk:high` clauses require a code-level human review through `urtext review --approve|--reject`, recorded against the current HEAD SHA. Changing HEAD invalidates the review. Green evidence alone never passes a high-risk clause because code remains the only reviewable fact on those paths.
- Review records persist in the database as the seed of the Decision ledger.

Acceptance achieved: C013 and `tests/review.test.ts` are green. High-risk work is traceable rather than deadlocked.

## M6 Memory layer: Decision ledger — complete

- A `manual` clause is always pending because no runnable oracle decides it. `urtext decide --pass|--fail` records a HEAD-bound human decision in `decisions`; only manual clauses can be decided. `urtext decisions` queries the ledger.
- The gate accepts a manual clause with a current pass Decision. Manual clauses do not enter cross-model meta-audit because the decision is ground truth.

Acceptance achieved: C014 and `tests/decision.test.ts` are green; the self-hosting unit has 14 decidable clauses. The four human touch points—unmapped acknowledgement, meta-audit disagreement, high-risk review, and manual decision—now have durable records.

## M5b Multimodal oracles — v1, deliberately deferred

- `visual` (screenshot diff against a design) and `interaction` (demo replay) oracle kinds.
- They require screenshot-diff/demo-replay runtime and conflict with the P8 serverless boundary. v1 may extend oracle kinds and `refs` target types without changing existing syntax.

## Seed-validation strategy

Recruit **10 design partners**: individual developers or 2–5-person teams who routinely use Claude Code/Codex and generate substantial AI-written code. Help each complete first adoption.

Success conditions:

- At least 7 write a real feature clause with an oracle and run `verify` within ten minutes.
- In week two, at least 4 run it at least three times without prompting.
- Median manual-oracle share stays below 50% (P9's load-bearing assumption).
- At least 3 explicitly state willingness to pay for a stable release.

Stop conditions:

- Users say authoring oracles costs more than reviewing code line by line: the assumption failed; stop expanding rather than adding features to hide it.
- Manual share stays above 50%: same response.
- Users judge Spec Kit or CodeRabbit sufficient: the differentiation failed; reassess the category.
