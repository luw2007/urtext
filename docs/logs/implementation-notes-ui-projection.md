# UI human-projection implementation notes

## Clean-cutover evidence

### Terra routine corrections (2026-07-27)

- C-1: moved the expensive deterministic fixture construction into one `beforeAll` lifecycle, with separate baseline and repeatability handles; full `tests/ui-acceptance-fixture.test.ts` now exits cleanly without a timeout increase.
- C-2: retained `#feature-health` on the projected `<ul>` and renamed its wrapper to `#feature-health-section`; focused renderer and browser-selector verification observe one `#feature-health` target.
- M-1: `captureFocusOrder()` now stops only when Tab naturally returns to its first recorded stop. A repeated stop before that closure remains in the recorded sequence for `validateFocusOrder()` to reject.
- M-2: stale runnable clauses now enter neither evidence nor audit numerators or denominators. A stale-only feature renders evidence and audit as `n/a (0/0)`.
- M-3: an agent-lane clause key is rejected with 409 before `buildBrief()` or the injected agent-spawn seam; normal current human clause, unmapped, refusal, and queue paths remain unchanged.
- Sol review follow-ups: `tests/ui-projection.test.ts` is staged as the dedicated C028 oracle; C008 is asserted as one coherent normative string; focused explain tests cover validated cap fallback, UTF-8-safe truncation, and deterministic queue prefix/omitted-tail accounting.
- The contrast manifest hashes were regenerated from compiled `verifyContrastManifest()` actuals after the renderer change.
- Final labelled-BFS correction: stale targets and their selected first-writer sources now come from the same labelled traversal. Direct FR defenders retain the FR stamp; simultaneous changed-defender descendants retain the clause label without a post-traversal source override. Focused linker coverage now pins multi-root ordering, second-event no-overwrite, and legacy-NULL preservation.
- Final explain correction: the current human/unmapped status-item path is positively covered with an injected transport; it accepts only the exact current key, fences status-item facts (including current `next`), performs one transport call, and leaves evidence/audit/decision/review/mapping ledger row counts unchanged.

### C028 dedicated oracle recovery (2026-07-27)

- Replaced the two smoke assertions in `tests/ui-projection.test.ts` with named behavioral C028 P1–P5/R4 cases. The oracle creates isolated git workspaces and SQLite registries, drives stale provenance through `propagateStale()`, renders console and successful/refused detail paths, invokes `handleExplain()` through injected fake transport, snapshots evidence/audit/decision/review/mapping ledgers, and calls the importable `status --json` handler for projection-only exit semantics.
- C028 recovery-audit completion adds exact agent-lane 409 guarding, a ready human-lane dangling-ref `buildBrief` refusal, FR/legacy/clause-key stale causality with the complete `重跑 urtext verify 前不放行` sentence, current human key-scoped explain success, key-XOR-scope 400, and injected transport-error 422. Every R4 assertion snapshots initialized nonempty evidence and confirms byte-identical ledger state.
- `node_modules/.bin/vitest run tests/ui-projection.test.ts` — 12 passed, exit 0.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.

## Focused verification observed

- `node_modules/.bin/vitest run tests/ui-acceptance-fixture.test.ts` — 14 passed, exit 0.
- `node_modules/.bin/vitest run tests/ui-console.test.ts` — 28 passed.
- `node_modules/.bin/vitest run tests/review-ui.test.ts` — 28 passed.
- `node_modules/.bin/vitest run tests/ui-server.test.ts -t "explain"` — 3 passed (including agent-lane no-spawn HTTP regression).
- `node_modules/.bin/vitest run tests/ui-projection.test.ts` — 2 passed.
- `node_modules/.bin/vitest run tests/ui-component-contrast.test.ts tests/ui-browser-check.test.ts` — 91 passed.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.
- Compiled `verifyContrastManifest()` — source and render assertions passed.
- Final targeted correction verification: `node_modules/.bin/vitest run tests/linker.test.ts` — 21 passed; `node_modules/.bin/vitest run tests/review-ui.test.ts -t "explain boundary" --testTimeout=30000` — 8 passed; `node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.

## Owner-operated recovery

C008 text changed and C022 references C008. The required C008 → C022 recovery remains owner-operated: index the change, re-verify C008 and C022, audit their new evidence, and obtain fresh current-HEAD high-risk reviews before any final gate claim. Full suite, full verify, and real browser acceptance were intentionally not run in this Terra correction pass.
