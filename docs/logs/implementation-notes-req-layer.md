# Requirement-layer implementation notes

Date: 2026-07-26

## Binding inputs

Implementation follows `docs/plans/urtext-20260726-req-layer-plan-final.md` over the Opus and Codex base plans. The final plan's adjudication table and 12-step implementation order are treated as the build contract. Both attack documents are used as regression requirements.

## Forced deviations

1. The generic `tdd-workflow` skill requests RED/GREEN checkpoint commits. The user explicitly required no commits, so no checkpoint commits will be created. RED/GREEN evidence will be captured through command output instead.
2. The generic `tdd-workflow` skill requests tests before production changes. The binding final plan explicitly orders production steps 1-7 before the new-test step 8, so implementation follows the plan's order.

No deviation from the requirement-layer plans has been required so far.

## Baseline evidence

- `npx tsc --noEmit`: exit 0 before implementation.
- `npm test`: the pre-change run reached environment failures before completion. Three `tests/ui-acceptance-server.test.ts` cases failed because the managed sandbox rejected `listen 127.0.0.1` with `EPERM`; one `tests/ui-acceptance-fixture.test.ts` case exceeded its existing 5 second timeout. The remaining reported tests were green. The run was stopped after several minutes without further output. Final acceptance will rerun the full suite and distinguish product regressions from the same restricted-network baseline.

## Implementation decisions

- `ClauseReq`/`ParsedRequirement` and `requirements.req_id`/`clause_reqs.to_req` follow Plan A naming; final-plan overrides are applied to their behavior.
- A present `req` value containing only comma/whitespace tokens emits one `malformed_req`; empty tokens beside a valid token are silently ignored exactly like `refs`.
- `ambiguous_req` is emitted for a bare binding with multiple same-unit live candidates. Explicit `path#FR<n>` remains exact; declarations without an ambiguous bare consumer do not invent a clause-less `LinkError`.
- All `LinkError` constructors populate `target`, while the property remains optional for source compatibility.
- Scanner reconciliation, workspace linking, and stale invalidation run inside one outer `better-sqlite3` transaction; existing inner transactions become nested savepoints. A trigger-induced invalidation failure test proves the revision append rolls back.
- Distill promotion preserves `req:` tokens. Per the final plan's narrow renderer ruling, this change does not invent or copy FR declarations during promotion; the target feature must already declare the referenced intent.
- During dogfood anchor migration, an intermediate local Perl capture-variable mistake briefly produced empty `req:` values. It was detected immediately by an explicit empty-binding scan and corrected from the adjudicated C-to-FR maps before any acceptance command.

## Acceptance evidence

- `npx tsc --noEmit`: exit 0.
- Focused FR/core suite: 108/108 tests passed across parser, registry, linker, status, distill, brief, verifier, gate, and package surface.
- Remaining affected fixture suite: 127/127 tests passed, including the unchanged UI contrast contract.
- Non-listener full Vitest run: 503/504 passed; the only failure was the acceptance fixture's existing 5 second timeout under concurrent load (5.146s). A fresh isolated run of that file passed 12/12; its first case completed in 4.327s.
- `npm test` cannot be fully green in this managed sandbox: three compiled-server cases fail before application startup because `listen 127.0.0.1` is denied with `EPERM`, matching the pre-change baseline. The concurrent acceptance fixture also crossed its 5 second timeout. No test was skipped or weakened to hide this environment boundary.
- `npm run build`: exit 0.
- Built CLI `index`: exit 0; all migrated specs/tasks ready. First FR scan invalidated 937 historical evidence rows across all 58 bound clauses, as designed.
- Built CLI `check`: exit 0 after migration and after every temporary demonstration was restored.
- Built CLI `verify`: exit 0; 54 pass, 0 fail, 4 manual pending, 100% pass rate.
- Built CLI `status --json`: `counts.uncovered = 0`, `uncoveredRequirements = []` on the migrated repository.
- Uncovered demonstration: temporarily deleting the sole `C005 -> FR005` edge produced exactly one uncovered FR while preserving the pre-existing status exit code (1 before and after); the edge was restored and uncovered returned to 0.
- Dangling demonstration: a temporary `C005 -> FR999` edge produced `unknown_req` and `check` exit 1; cleanup restored `check` exit 0.
- Stale demonstration: both FR-only text change and simultaneous clause+FR text change stamped the bound clause once (`invalidated_at = 99`, `invalidatedEvidence = 1`).
- `src/ui/`: zero diff bytes.

## Final fresh verification

- A fresh post-cleanup `npx tsc --noEmit` completed with exit 0.
- A fresh `npm test` ran to completion: 506 passed, 34 failed, and 7 were skipped. All 34 test failures require a loopback listener: 31 `tests/ui-server.test.ts` cases timed out after the sandbox rejected `listen 127.0.0.1` with `EPERM`, and 3 compiled-server cases reported the same `EPERM` directly. The unrelated `tests/package-consumer.test.ts` suite also failed during setup before its 7 tests could run because `npm pack` could not write the sandbox-external `~/.npm/_cacache/tmp`; moving the cache to a writable temporary directory then proved that the offline install cannot use the read-only populated cache (`ENOTCACHED`). No implementation or test was changed to hide these managed-sandbox restrictions. `tests/ui-acceptance-fixture.test.ts` passed 12/12 in this full run.
- Fresh focused registry/linker verification passed 30/30. A separate focused acceptance demonstration passed 5/5 assertions for FR-only stale propagation, removed-FR old-key matching, simultaneous clause+FR single stamping, uncovered-FR reporting, and uncovered isolation from queues/WIP/exit state.
- A fresh `npm run build` completed with exit 0. The built CLI then completed `index` and `check` with exit 0, and `verify` with exit 0: 54 pass, 0 fail, 4 manual pending, 100% pass rate.
- Fresh built-CLI status evidence reported `counts.uncovered = 0` and `uncoveredRequirements = []`. Its exit code remained 1 because the uncommitted implementation worktree has 238 unmapped diff items; uncovered requirements do not contribute to that exit state.
## Post-gate fix round (owner, after Sonnet review + Opus adversarial test)

Review verdict was REQUEST CHANGES (1 HIGH, 3 MEDIUM); adversarial test verdict was APPROVE-WITH-NITS (1 MAJOR). Fixes applied:

1. **HIGH — `distill promote` into a fresh feature produced a workspace failing its own `check`.** `promote` now carries the draft's FR declarations for unit-local `req:` bindings the target does not declare, and fails closed (`draft does not declare FR<n>`) when neither side declares one. Two new tests in `tests/distill.test.ts` defend both paths.
2. **MEDIUM — `renderBaselineClauses` emitted grammar-invalid clause headings** (`missing_requirement` if parsed). Baseline docs are observed-fact renders, not clause files; headings are demoted to `## Baseline C<n> — …` so they no longer parse as normative clauses. Test asserts the render yields zero parsed clauses.
3. **MEDIUM — FR pure additions were direct-stamped.** `changedRequirements` now excludes additions (no prior hash): nothing bound them before, so no prior evidence exists to invalidate. Kills the spurious first-index `~ stale:` line and the tombstone-restore self-stamp. Known window accepted: a tombstone→restore that also modifies FR text does not stamp (tombstoning is itself never triggered by `scanWorkspace` — inherited v0 gap).
4. **MEDIUM — `clauses.reqs` was write-only.** `brief` now reads the serialized column (source order, symmetric with `refs`) instead of re-querying `clause_reqs`.
5. **MAJOR — `check --json` dropped `LinkError.target`.** Owner re-ruling on adjudication 8: the "cli.ts 零改动" constraint was about avoiding the discriminated-union refactor, not about withholding the field; machine readability wins. The projection now spreads `target` when present (`exactOptionalPropertyTypes`-safe).
6. **MINOR — `docs/SYNTAX.md` over-claimed req/refs dedupe parity.** Reworded: comma/empty-token handling mirrors `refs`; duplicate-token removal is `req`-only.

Accepted without action (inherited v0 boundaries, recorded by the gates): whole-file tombstoning never triggered by `scanWorkspace` (symmetric for refs/reqs); coverage computed over `building` revisions (cannot produce a false green — check/verify/status all exit 1 there); `revisions.grammar_version` describes clause-file grammar only.

Post-fix evidence: `npx tsc --noEmit` exit 0; `npm test` 549/549 (one earlier flaky acceptance-fixture timeout under concurrent load did not reproduce); built CLI `index`+`check` exit 0; `status --json` `counts.uncovered=0`; scratch-workspace `check --json` carries `"target": "FR999"` for a dangling req; `verify` 54 pass / 0 fail / 4 manual pending, manual share 7%.
