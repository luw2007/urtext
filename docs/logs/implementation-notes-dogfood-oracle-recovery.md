# Implementation Notes — dogfood oracle recovery

## Scope

Applied the nine factual oracle-coverage repairs from `.urtext/audit-final-full-omp.md` without changing clause semantics or product behavior.

## Decisions and recovery details

- **D1 / C004:** `tests/verifier.test.ts` now creates an isolated workspace with a failing ready `test` oracle, calls importable `run(['verify'])`, asserts exit code `1`, and queries the workspace ledger to prove failed evidence was appended.
- **D2 / C005:** `tsconfig.repo.json` is a no-emit strict project covering every `src/**/*.ts`, `tests/**/*.ts`, and `scripts/**/*.ts` file. Its initial run exposed 27 strict diagnostics in included test fixtures; those fixtures were made type-correct rather than excluded. `scripts/oracle-typecheck.sh` runs and names both the source and repo-wide projects. `tests/full-test-static.test.ts` pins coverage and both invocations.
- **D3 / C015:** `scripts/oracle-wiki.sh` extracts the `COMMANDS` object keys plus the separately dispatched `ui` command from `src/cli.ts` at execution time, rejects an empty extraction, and emits one named evidence line per documented runtime command.
- **D4 / C019:** `tests/spec-impact-interactions.test.ts` now uses registry evidence, a real scanner-driven stale change, task links, real Git commits, and `recordMapping()` to assert risk, subject-current evidence stale, impact, no mapping, no-change, diff-failure, and intersect-only mapping-HEAD-to-worktree diff states. It no longer injects a mapping into the render view.
- **D5 / C020:** named registry tests assert `missing_requirement`, plus `oracle_on_requirement` and `risk_on_requirement`, each keeping its revision at `building`.
- **D6–D8 / C105, C204, C302:** the loops oracle now emits verified assertions and pins every enumerated shell-safety rule in both cores, all four finder angles plus current-trunk independent verification, and the operative same-change test requirement.
- **D9 / C503:** the canonical integrate-worker skill now explicitly says `unmapped` non-empty, unadjudicated diffs must not merge; the oracle pins that sentence and the full write-back-or-manual-ack branch.

## Focused verification

- `node_modules/.bin/vitest run tests/verifier.test.ts --reporter=verbose` — 10 passed.
- `node_modules/.bin/vitest run tests/registry.test.ts --reporter=verbose` — 15 passed.
- `node_modules/.bin/vitest run tests/spec-impact-interactions.test.ts tests/spec-impact-unmapped.test.ts --reporter=verbose` — 8 passed.
- `node_modules/.bin/vitest run tests/full-test-static.test.ts --reporter=verbose` — 7 passed.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.
- `node_modules/.bin/tsc --noEmit -p tsconfig.repo.json` — passed.
- `sh scripts/oracle-typecheck.sh` — passed with both named checks.
- `sh scripts/oracle-wiki.sh command-coverage` — passed with 16 named runtime-command checks.
- `sh scripts/oracle-loops.sh shell-safety`, `model-split`, `coverage-follows-capability`, and `unmapped-gate` — each passed with named assertions.
- `node_modules/.bin/vitest run tests/hunt-knownbugs.test.ts tests/oracle-runner-local-tool.test.ts tests/ui-browser-check.test.ts tests/ui-browser-check-wrapper.test.ts tests/ui-component-contrast.test.ts tests/ui-acceptance-server.test.ts tests/ui-server.test.ts --reporter=verbose` — 144 passed; this exercises the included fixtures repaired after the repo-wide strict check surfaced their diagnostics.
- `git diff --check` — passed.

No full suite, full `verify`, or full gate was run by design.
