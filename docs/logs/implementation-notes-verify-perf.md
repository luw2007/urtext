# Implementation Notes — verify batch + incremental (perf/verify-batch)

Plan: `docs/plans/urtext-20260727-verify-perf-plan-final.md` (adversarial: Opus planner vs Codex gpt-5.6-sol; Opus lever B+C won on measurement, two Codex amendments adopted).

## Decisions not covered by the plan

- **Fingerprint priming (MAJOR-3 / acceptance gate 4 failure).** The plan's §2.2 sample gated fingerprint *computation* on `--incremental`, so a plain full `verify` stamped NULL and incremental never primed — contradicting the plan's own §7.5. Fixed: fingerprint always computed and stamped; only the reuse lookup is flag-gated.
- **Taint over global fail (F1).** When a batch exits non-zero *and* some file legitimately failed, an unattributable leak in another file is indistinguishable from the sibling's failure. OpusTest proposed failing every non-failed ref; rejected — one red file would turn all ~30 test clauses red. Shipped instead: per-clause attribution stands, but every row from a red batch (`tainted`) is stamped `input_fingerprint = NULL`, so a potentially-lying pass is never reusable. Regression test pins this.
- **Post-batch fingerprint recompute.** An edit landing mid-run stamps NULL (rows describe bytes that no longer exist). Verified live by mutating a tracked file 15s into a run: all 61 rows NULL.
- **Review hardening beyond plan:** unexplained-exit guard (vitest exit 1 with green JSON → fail all refs), collection-failure `message` binding, per-entry report shape validation, lowercase ref matching (vitest parity), `\u0000` delimiters in fingerprint material, git helper 30s timeout, `duration_ms` rounding.
- **Flaky suite fix (F2):** `tests/ui-acceptance-fixture.test.ts` first test runs ~4.3s against the 5s default; raised to 30s.

## Measured acceptance (Apple M4 Max, Node v26.4.0, vitest 3.2.7, quiet machine — OpusTest report)

| gate | target | measured | result |
|---|---|---|---|
| full `verify` | <120s | **51.03s** (11.7× vs 595s baseline), 57 pass / 0 fail / 4 pending, +61 rows | PASS |
| `verify --incremental` on unchanged tree | <15s | **1.55s**, 32 reused, +29 rows (25 cmd + 4 manual), zero rows for reused test clauses | PASS |
| verdict parity vs 56/0/4 | empty diff | 0 changed, 0 removed, 1 added (C027 pass) | PASS |
| tracked edit degrades to full | full run | 50.67s, 0 reused, +61 rows | PASS |
| mid-run mutation not reusable | NULL stamps | all 61 rows `input_fingerprint = NULL` | PASS |
| full suite | green | 38 files / 568 tests, 74.74s | PASS |

Per-clause `duration_ms` for batched test oracles is the file's own test time and deliberately does not sum to wall time.
