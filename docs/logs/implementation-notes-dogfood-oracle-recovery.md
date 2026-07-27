# Implementation Notes — dogfood oracle recovery

## Scope

Records the earlier full-audit recovery, the final D1–D11 factual oracle-coverage batch, and the bounded eight-item stop-line recovery from `.urtext/audit-stopline-omp.md`; none changes clause semantics or product behavior.

## Decisions and recovery details

- **D1 / C004:** `tests/verifier.test.ts` now creates an isolated workspace with a failing ready `test` oracle, calls importable `run(['verify'])`, asserts exit code `1`, and queries the workspace ledger to prove failed evidence was appended.
- **D2 / C005:** `tsconfig.repo.json` is a no-emit strict project covering every `src/**/*.ts`, `tests/**/*.ts`, and `scripts/**/*.ts` file. Its initial run exposed 27 strict diagnostics in included test fixtures; those fixtures were made type-correct rather than excluded. `scripts/oracle-typecheck.sh` runs and names both the source and repo-wide projects. `tests/full-test-static.test.ts` pins coverage and both invocations.
- **D3 / C015:** `scripts/oracle-wiki.sh` extracts the `COMMANDS` object keys plus the separately dispatched `ui` command from `src/cli.ts` at execution time, rejects an empty extraction, and emits one named evidence line per documented runtime command.
- **D4 / C019:** `tests/spec-impact-interactions.test.ts` now uses registry evidence, a real scanner-driven stale change, task links, real Git commits, and `recordMapping()` to assert risk, subject-current evidence stale, impact, no mapping, no-change, diff-failure, and intersect-only mapping-HEAD-to-worktree diff states. It no longer injects a mapping into the render view.
- **D5 / C020:** named registry tests assert `missing_requirement`, plus `oracle_on_requirement` and `risk_on_requirement`, each keeping its revision at `building`.
- **D6–D8 / C105, C204, C302:** the loops oracle now emits verified assertions and pins every enumerated shell-safety rule in both cores, all four finder angles plus current-trunk independent verification, and the operative same-change test requirement.
- **D9 / C503:** the canonical integrate-worker skill now explicitly says `unmapped` non-empty, unadjudicated diffs must not merge; the oracle pins that sentence and the full write-back-or-manual-ack branch.
- **D1–D11 / final dogfood audit:** `scripts/oracle-loops.sh` uses a fixed-string `check()` helper that prints each source-backed assertion. It pins C201's complete minimal-repro/run/timeout/observed-output rule; C301's reproduce-before-change and refuted-bug regression PIN rule; all seven C501 protocol steps, including the full-test/format and bounce bodies; C306's hunk-to-clause and `meta.unmapped` provenance rules; and C104's hunt-prompt `Read docs/VISION.md first` line.
- **Stop-line C203/C205/C303/C305/C502:** C203 now pins both least-recent selection and `ledger.swept[area.id] = new Date().toISOString().slice(0, 10);`; C205 pins each quoted-and-comma-terminated category entry, including `"crash",`; C303 emits six isolated-worktree assertions for worktree creation, the exact four-worker cap, runtime cap enforcement, diff output, structured meta output, and no-direct-merge wording; C305 pins the stale-comment same-change sentence fragment; C502 pins the human-maintained hotspot roster, its table header, a concrete roster row, and the disjoint-module/serial-hotspot rules.
- **Stop-line C007/C021:** `tests/linker.test.ts` creates a committed, ready-only isolated Git workspace whose only failures are `unknown_ref` and `unknown_req`; it drives importable `run(['check'])` and `run(['check', '--json'])`, asserting exit `1` in both modes.
- **Stop-line C018:** `tests/brief-gate.test.ts` calls the domain `recordDecision()` write path for a high-risk manual pass carrying the current brief hash after making the real workspace dirty, and asserts `dirty_worktree` rejection.
- **Evidence freshness:** no full `urtext verify` was run for this bounded recovery. The pre-existing evidence rows 2400–2461 retain their prior input fingerprint and must be treated as stale for this changed workspace regardless of `audit --export`; re-mint every row with a full verification before relying on them.

## Focused verification

- `node_modules/.bin/vitest run tests/verifier.test.ts --reporter=verbose` — 10 passed.
- `node_modules/.bin/vitest run tests/registry.test.ts --reporter=verbose` — 15 passed.
- `node_modules/.bin/vitest run tests/spec-impact-interactions.test.ts tests/spec-impact-unmapped.test.ts --reporter=verbose` — 8 passed.
- `node_modules/.bin/vitest run tests/full-test-static.test.ts --reporter=verbose` — 7 passed.
- `node_modules/.bin/vitest run tests/dwarf.test.ts --reporter=verbose` — 13 passed, including dirty-worktree text and JSON CLI exit enforcement.
- `node_modules/.bin/vitest run tests/distill.test.ts --reporter=verbose` — 25 passed, including invalid-declaration CLI exit enforcement.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.
- `node_modules/.bin/tsc --noEmit -p tsconfig.repo.json` — passed.
- `sh scripts/oracle-typecheck.sh` — passed with both named checks.
- `sh scripts/oracle-wiki.sh command-coverage` — passed with 16 named runtime-command checks.
- Earlier focused commands listed above were run before this bounded stop-line recovery.
- `node_modules/.bin/vitest run tests/linker.test.ts --reporter=verbose` — 22 passed, including ready-only `unknown_ref`/`unknown_req` text and JSON CLI exits.
- `node_modules/.bin/vitest run tests/brief-gate.test.ts --reporter=verbose` — 12 passed, including current-hash dirty-worktree decision rejection.
- `sh scripts/oracle-loops.sh rotation`, `categories`, `isolation`, `no-scope-creep`, and `lane-discipline` — each passed and printed every source-backed assertion.

No full suite, full `verify`, or full gate was run by design.
