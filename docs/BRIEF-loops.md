# Workflow Scaffold Usage and Test Brief

> Companion material: `specs/loops/spec.md` (mechanism clauses), `.claude/checklists/` (human acceptance points), `.claude/workflows/` (workflow sources), and `.claude/skills/integrate-worker/SKILL.md` (integration protocol).

## Boundary

The hunt, fix, and audit workflows are portable definitions for an external agent harness. They require harness-provided `agent()`, `parallel()`, `read()`, `write()`, and `log()` primitives, plus Bun, GitHub CLI, and Git worktrees. This repository does not supply that runtime; they are not programs that can be directly started with Node. Their load-bearing rules live in `specs/loops/spec.md` and are verified by `urtext verify`.

## Priorities

1. Keep mechanism clauses green through `urtext verify`.
2. Establish the oracle-and-traceability foundation before workflows.
3. Connect hunt first: discovery → reproduction → archive.
4. Introduce fix and integrate together; worker output is untrusted until re-proven on fresh trunk.
5. Run audit once per sprint to prevent oracle rot.

## What can run now

```bash
urtext verify
sh scripts/oracle-loops.sh shell-safety && echo GREEN
bun build .claude/workflows/urtext-overnight-hunt.js --no-bundle
npx vitest run && npx tsc --noEmit -p tsconfig.json
sh scripts/loops-smoke.sh
```

These validate mechanism text, static workflow syntax, and repository tests. They do **not** prove end-to-end autonomous execution.

`scripts/loops-smoke.sh` is the narrower DRY_RUN exception: without a harness, its inline stub runtime runs all three loop cores through the empty-state skeleton and asserts the hunt ledger write, fix metadata write, and audit JSON write. This fulfills the source design's known unknown #1—whether the three end-to-end loop skeletons can run through an empty state. End-to-end execution with real models, `gh`, and Git still requires the host harness.

## Using a real harness

A harness must provide the prelude primitives and have Bun, authenticated `gh`, and Git available. Run the workflow through the host harness, not Node:

```text
<harness-run> .claude/workflows/urtext-overnight-hunt.js
<harness-run> .claude/workflows/urtext-fix-cycle.js
<harness-run> .claude/workflows/urtext-spec-audit.js
```

A fix run first needs `.claude/workflows/fix-cycle-input.json`. Its diff and metadata are never auto-merged: a human or main agent follows the seven-step integration protocol and reruns the reproduction on fresh trunk.

## GitHub feedback boundary

GitHub is the durable queue and evidence boundary, not the agent runtime:

1. A hunt finding enters through the **Hunt finding** issue form only after a timeout-wrapped minimal repro ran. It receives `loop:hunt` and `evidence:required`; duplicate search happens before filing.
2. A fix PR closes its issue with `Fixes #NN`, records actual verification output, and declares every non-spec hunk as clause-mapped or explicitly unmapped. Actions require the declaration and run typecheck, tests, build, and `urtext verify`.
3. Unsafe or high-risk work also requires `risk:high` plus the maintainer-applied `decision:human-approved` label. The label is the durable gate record; an agent cannot self-declare it in prose.
4. A real harness runs the read-only four-lens audit. Its JSON findings are dispatched to **Audit feedback**; Actions first rerun the toolchain evidence, then reject incomplete findings, deduplicate open issues, and file only admissible findings as `loop:audit`. Critical/high findings also receive `risk:high`.

The scheduled audit workflow intentionally does not claim to run the four lenses: GitHub runners lack the harness primitives. It executes reproducible repository gates weekly; audit findings enter only through a manually dispatched, structured evidence payload.

## Smoke-test order

1. Hunt an unimplemented area: expect no findings, no issue, and an updated ledger.
2. Hunt one implemented area: require `no repro, no report`.
3. Run one fix worker: confirm isolated worktree and diff/meta output.
4. Integrate manually: ensure fresh-trunk reproduction rejects stale-base false green.
5. Audit read-only: verify it mutates neither files nor issues.

Parallel fix-worker isolation is evidenced rather than inferred: cluster-keyed worktree paths are disjoint, `.urtext/` is gitignored so each worktree uses a path-local registry and WAL file, and registry tests use `:memory:`. These three static facts are sufficient to rule out cross-worker registry-file contention; no concurrent stress test was performed.

Risks include mistaking green text checks for effective mechanisms, claiming workflows run without a harness, skipping the verification foundation, shell-safety regressions, stale-worker validation, an obsolete AREA map, parallel workers touching hot files, and rising manual share. Each has a corresponding clause, checklist, or human gate; none should be silently downgraded.
