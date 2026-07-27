# Brief: Cut `urtext verify` wall time (owner: fable-5)

## Problem (measured facts)
- Repo: /Users/luwei.will/ai/urtext (TypeScript, node:sqlite registry, vitest).
- `urtext verify` full run: 56 pass / 0 fail / 4 pending in ~597s wall.
- Root causes located:
  1. `src/verifier.ts` iterates clauses serially (`for (const row of rows)`), each oracle via `spawnSync` (src/oracle-runner.ts:36) — fully sequential, blocking.
  2. Each `test` oracle spawns its own `npx vitest run <file>` — vitest cold start (~2-10s) dominates; multiple clauses often bind the SAME test file and re-run it.
  3. No incremental mode: non-stale clauses with current pass evidence re-execute every time.

## Goal
`urtext verify` on this repo drops from ~600s to a target of <120s full / <15s incremental, WITHOUT weakening the evidence contract:
- Evidence stays append-only, per-clause verdict + exitCode + capped output + duration_ms.
- P2: completion remains a read-only aggregate of objective verdicts. No caching that can serve stale verdicts for changed clauses (stale propagation via `invalidated_at` must still force re-run).
- Fail-closed semantics unchanged; exit codes unchanged.

## Constraints (KISS, first principles)
- No daemon, no server, no new heavyweight deps (P8 serverless). Node built-ins preferred.
- Deliberate simplifications must be marked with ceiling comments.
- Config over hard-coded thresholds (e.g. concurrency via env/flag with sane default).
- Surgical diffs; match existing code style (no-semicolon TS, arrow consts).
- Must keep self-hosting green: `urtext check && urtext verify` on this repo.

## Candidate levers (challenge or improve these)
A. Parallel oracle execution (async spawn, bounded concurrency, deterministic evidence ordering).
B. Batch dedup: group clauses sharing one test file into a single vitest invocation; attribute per-clause verdicts from vitest JSON reporter output.
C. Incremental verify (`verify --changed` or default?): skip clauses whose latest evidence is pass, not invalidated, and whose clause text_hash + HEAD unchanged. Decide the safety semantics carefully — evidence freshness vs. code drift (a code edit without clause change WOULD be missed; interplay with DWARF/check --diff must be stated).
D. Single warm vitest programmatic run (vitest node API) — weigh against added coupling.

## Deliverable expected from each planner
A technical plan WITH core code sketches (TypeScript, matching repo style) for the chosen levers, explicit risk list, and test/acceptance plan (which existing tests prove nothing regressed; what new observable contract needs a test). Name what you REJECT and why.
