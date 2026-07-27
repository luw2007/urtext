# Urtext UI Human-Projection — OMP Owner Revalidation

**Authority.** This is the owner revalidation for the round-3 implementation. It supersedes the dirty working tree, which is an untrusted interrupted prototype, not an implementation baseline. The source baseline is committed `c53764e` (which already owns C027 through `specs/urtext/spec.md:233-238` and T018 through `specs/urtext/tasks.md:35-36`). All line references below are to the current working tree only where a prototype observation is explicitly called out; contractual facts are grounded in committed/source behavior named at the cited paths.

**Decision.** Implement the ratified contract below as one clean cutover. Do not retain prototype-only APIs, compatibility aliases, or a second projection path. The AI explanation response is transient UI/request data only: it MUST NOT be inserted into `registry.sqlite`, `evidence`, `audit_verdicts`, `reviews`, or `decisions`.

## 1. Revalidation of preliminary synthesis

### 0a — ratified, with committed-baseline correction

**RATIFIED.** The UI dogfood clause is **C028**, not C027. `c53764e` already committed C027 as the verify-performance clause (`specs/urtext/spec.md:233-238`); a second C027 would trigger the parser's duplicate-clause failure. The new task is **T019**, depends on **T018**, and cites **C028** (`specs/urtext/tasks.md:35-39`). No dynamic numbering, sibling migration, or reuse of T018 is permitted.

### 0b — ratified

**RATIFIED.** Before the schema/code change is dogfooded, C008 MUST say exactly:

> 其既有证据的作废戳（`invalidated_at` + `invalidation_source`）在同一事件中写入——证据唯一可变面，作废不删除（审计保留）。

This replaces the old single-column claim at baseline `specs/urtext/spec.md:110-114`. `src/verifier.ts` MUST describe the same two-column logical stamp; the current prototype’s wording at `src/verifier.ts:38-42` is directionally correct but remains untrusted until cleanly reimplemented.

The cascade is mandatory and ordered: modifying C008 changes its `text_hash`; C022 references C008 (`specs/urtext/spec.md:200-204`); stale propagation must invalidate C022’s prior evidence; then C008 and C022 each require fresh verification, a targeted audit of their new evidence, and fresh current-HEAD high-risk review before the final gate. Extend C008’s dedicated oracle, `tests/linker.test.ts`, to prove both columns are written by one invalidation event and that legacy source remains NULL.

### Rulings 1–24

| # | Owner disposition | Binding implementation requirement |
|---|---|---|
| 1 | **RATIFIED** | Extend `EVIDENCE_SCHEMA` after committed `input_fingerprint TEXT` with `invalidation_source TEXT`; add exactly the fourth idempotent `ALTER TABLE evidence ADD COLUMN invalidation_source TEXT` in `ensureEvidenceLedger` (`src/verifier.ts:18-60`). Do not add a new transaction wrapper: `scanWorkspace()` already wraps reconciliation and propagation in one transaction (`src/scanner.ts:77-133`). |
| 2 | **RATIFIED** | Use one labelled reverse BFS and make the existing key-only reverse closure a wrapper over it. The stale set and its cause map MUST derive from the same traversal. A direct FR-hit clause is stamped with its FR key; its reverse-ref dependents inherit the changed clause key when that clause also changed. Multi-root ties use incoming seed order, first writer wins. Preserve `WHERE invalidated_at IS NULL`; legacy NULL source is never backfilled. |
| 3 | **AMENDED** | Compose the causal line in `src/ui/render-console.ts`, inside the dual-hash source set. Exact copy is: sourced: `<origin> 文本变更 → <clause key> 证据作废 → 重跑 verify 前不放行`; legacy: `上游变更 → <clause key> 证据作废 → 重跑 verify 前不放行`. This is the final owner wording; it deliberately avoids claiming re-review is always required after re-verification. |
| 4 | **RATIFIED** | Add optional `BriefManifest.invalidationSource` only when the latest evidence row is stale and has a non-NULL source; it participates in the existing `JSON.stringify(manifest)` brief hash (`src/brief.ts:217-305`). |
| 5 | **RATIFIED** | Aggregate P2 in `src/ui/render-console.ts` from raw `UiClause` plus existing `StatusReport.uncoveredRequirements`; do not add `featureHealth` to `StatusReport` or `status --json`. The renderer is already in both contrast hash implementations (`tests/ui-component-contrast.test.ts:83-92`, `scripts/ui-browser-check.ts:112-121`). |
| 6 | **RATIFIED** | In P2, a stale pass contributes neither evidence numerator nor denominator; a high-risk approval counts only when `reviewStatus === 'approved'` and the snapshot is clean. Audit agreement uses existing auditable runnable-clause facts. No health calculation changes `items`, counts, WIP, or exit status (`src/status.ts:160-205`; C023 at `specs/urtext/spec.md:206-210`). |
| 7 | **RATIFIED** | Render one queue-only `<ul>`, never a second `<table>`, because console routes have a one-table assertion. Place it after the fail-closed workspace alert and before the queue table. Every zero denominator renders `n/a (0/0)`. Each feature link routes to existing `/specs`; no route/query/dependency is added. |
| 8 | **RATIFIED** | Add `ImpactReport.directClauses` by filtering the existing `impact()` reverse-closure graph pass; do not issue another SQL query. The existing clause-impact CLI must continue reading only `affectedClauses`/`affectedTasks` and remain byte-for-byte stable (`src/cli.ts:675-694`). |
| 9 | **RATIFIED** | Render P3 as flex-wrap boxed HTML/CSS using no SVG, canvas, visualization library, grid-track layout, or dependency. It has exactly defended resolved FRs, self, manifest refs, and `directClauses`; closure-only dependents stay out. Verify at 390 px. |
| 10 | **RATIFIED** | Keep `/api/explain`. Accept exactly one of `{key, auditor, model?}` or `{scope:'queue', auditor, model?}`; both/neither are 400. A clause key must parse as `<non-empty path>#C\d+` before `buildBrief`. Existing Host, Origin, CSRF, exact JSON media type, 4096-byte inbound body cap, JSON parse, and handler order remain intact (`src/ui-server.ts:81-115,232-331`). |
| 11 | **RATIFIED** | Every human queue row receives an explain control. A normal clause uses a manifest-only clause prompt. An unmapped row uses a status-item prompt only after an exact current human/unmapped match. A refused clause brief retains its visible control but returns the original refusal as 409 without fabricated clause facts. Agent-lane rows get no per-row control. |
| 12 | **RATIFIED** | Clause facts are a deterministic bounded projection of `BriefManifest` only: include `schema`, `head`, `specPath`, `clauseId`, `title`, `body`, `oracleKind`, `oracleRef`, `risk`, `refs`, `reqs`, `stale`, optional source, evidence, audit verdict, and mappings. Do not call `renderBriefText`, `briefHistory`, or include ledger note/evidence-output prose. |
| 13 | **RATIFIED** | Every prompt fences the serialized facts between `BEGIN_URTEXT_FACTS` and `END_URTEXT_FACTS`, declares them untrusted data rather than instructions, prohibits tools/files/network/writes, and requires each substantive conclusion to cite a JSON field path. |
| 14 | **RATIFIED** | Both clause/item and queue prompts use exactly these three H2 headings: `为什么需要你`, `批准与拒绝分别意味着什么`, `哪里有风险信号`. No queue-specific synonym is allowed. Non-approve/reject items say “不适用” and cite their current `next` action. |
| 15 | **RATIFIED** | Use a validated environment-configured UTF-8 byte ceiling with a named default. It bounds clause, unmapped, and queue facts. Queue serialization includes human, agent, and uncovered surfaces; each lane is a deterministic prefix, reports omitted-tail counts, and explicitly says only the first N items are present. Do not hard-code an unconfigurable threshold or admit a later small item after a larger earlier item fails the budget. |
| 16 | **RATIFIED** | Give every per-row explain button and output a unique dynamic ID following the existing indexed decision-form pattern; use static `queue-explain-btn` and `queue-explain-out` for the queue control. |
| 17 | **RATIFIED** | Repair the browser checker’s focus identity, not navigation markup: an id-less focusable element identifies as `tagName[focusable-index]`, while a real repeated focus stop remains detectable. The current implementation locus is `scripts/ui-browser-check.ts:768-783`; adding ids to all nav links is rejected. |
| 18 | **RATIFIED** | Use one `approvalSemantics(head)` formatter and render static P5 copy beside both approve and decide submissions. It includes the render input’s HEAD short SHA and exactly `代码再动自动失效，需重审`; it is copy only and does not bypass `recordReview`/`recordDecision` guards (`src/review-ui.ts:314-350,679-726`). |
| 19 | **RATIFIED** | Register every visible P1–P5 branch separately in canonical contrast coverage: health empty/nonempty; each evidence/audit/high-risk denominator, complete, incomplete state; uncovered zero/nonzero; sourced/legacy causal; queue/clause/unmapped explain; P5 copy; neighborhood each present/empty side; generalized brief explain. Ensure raw fixture data executes renderer aggregation. |
| 20 | **RATIFIED** | Regenerate the two hashes exclusively from compiled `verifyContrastManifest()` actuals. Replace `sourceContractSha256` and `renderContractSha256` in place with anchored, per-field regexes that each match exactly once or throw. No hand-computed digest and no committed writer. Then both independent verifiers must pass. |
| 21 | **RATIFIED** | Extend the deterministic acceptance fixture with a clean third commit that rewords C001, scans, and proves C002 is stale with source `specs/demo/spec.md#C001`; browser acceptance must observe the causal row. Also make real queue-item and brief explain clicks prove disabled-during-request, aria-live output, one request, and one local stub invocation. |
| 22 | **AMENDED** | Preliminary #22 correctly changed the identifier to C028, but its two refs were incomplete. Exact C028/T019 are in §3: C028 refs C008 (stamp source), C016 (lane/queue projection), C019 (brief UI), and C026 (FR/detail projection), and has the standalone `tests/ui-projection.test.ts` oracle. |
| 23 | **RATIFIED** | Update `docs/SYNTAX.md`, `docs/zh-CN/SYNTAX.md`, and EN/ZH registry, verifier, and linker-impact mechanism pages to call the two fields one logical invalidation stamp. Do not modify command references because no command changed. |
| 24 | **RATIFIED** | R4 is absolute: no explanation response is persisted or included in evidence/audit/review/decision inputs. `runAgentText` remains read-only and failure returns an error response; the UI does not manufacture a successful explanation. |

## 2. Dirty-prototype disposition — every product file

The following is a source-grounded review of every dirty **product** path. Tests are addressed separately because they are not product behavior. `KEEP` means retain only the stated behavior after a clean rewrite; it does not bless the existing diff.

| Dirty product file | Disposition | Owner reason |
|---|---|---|
| `scripts/ui-acceptance-fixture.ts` | **REWRITE** | Keep the third deterministic C001 commit and C002 source assertion, but derive its final fixture/count expectations after the clean domain implementation. It is the needed real P1 chain; the prototype’s added delays and its stale-sensitive C004 reviewability must be revalidated. |
| `scripts/ui-browser-check.ts` | **REWRITE** | Keep seven pages, selector/AX additions, real explain clicks, and focus-identity repair. Rewrite its expectations so C002’s stale state is observed on `/agent`, not merely selector-counted; preserve existing response/security checks. |
| `specs/urtext/spec.md` | **REWRITE** | Keep only exact C008 wording from §0b and exact C028 from §3. The prototype omits the owner-required C008/C022 cascade plan and has incomplete C028 refs. |
| `specs/urtext/tasks.md` | **REWRITE** | Keep T019, not a repurposed T018; it must depend on committed T018 and cite C028. |
| `src/brief.ts` | **KEEP** | Retain optional stale-source selection into `BriefManifest` and therefore its brief hash. Preserve absence for fresh or legacy-NULL rows. |
| `src/gate.ts` | **KEEP** | Retain raw nullable `invalidationSource` on the adjudication fact path. It must not alter gate reasons or verdicts. |
| `src/linker.ts` | **REWRITE** | Keep the labelled-BFS direction, same-event two-column UPDATE, direct `ImpactReport.directClauses`, first-stamp guard, and counterfactual C+FR semantics. Rewrite because the exported `StaleReport` comment/type and exact deterministic tie tests must match the owner contract, not the prototype by coincidence. |
| `src/review-ui.ts` | **REWRITE** | Keep raw P2 inputs, P3 plumbing, exclusive explain union, manifest-only fenced facts, and fallbacks. Rewrite bounded serialization to guarantee the final UTF-8 ceiling, prefix semantics, omitted accounting, refused-clause 409 behavior, and zero registry writes; no hidden narrative/history/evidence output may enter facts. |
| `src/status.ts` | **KEEP** | Retain optional source on stale `StatusItem` only. Do not add a health result or change lanes/counts/WIP/exit semantics. |
| `src/ui/brief-script.ts` | **KEEP** | Retain generalized successful-brief explain control based on `data-explain-key`; it must keep CSRF, disabled state, and aria-live behavior. |
| `src/ui/console-script.ts` | **REWRITE** | Retain delegated queue/per-item calls, but rewrite with explicit typed/null-safe DOM checks and exact request payloads. It must never post an undefined key and must map every unique button to its matching output. |
| `src/ui/contracts.ts` | **KEEP** | Retain additive P3 view facts (`refs`, direct dependents) required by the renderer. Update all constructions in the clean cutover; no optional silent fallback. |
| `src/ui/html.ts` | **KEEP** | Retain a single escaped P5 formatter returning the exact owner copy. Do not move causal composition here; it stays renderer-owned. |
| `src/ui/render-brief.ts` | **REWRITE** | Keep flex-wrap P3, generalized brief explain, and P5 copy. Rewrite neighborhood markup so it contains only P3’s four one-hop elements, never closure-only data; preserve error-shell absence of controls. |
| `src/ui/render-console.ts` | **REWRITE** | Keep renderer-owned P2, `<ul>`, source/legacy causal rendering, human-row controls, queue control, and P5 copy. Rewrite placement and branch IDs to make alert → health → queue deterministic and fully contrast-covered. |
| `src/ui/theme.ts` | **KEEP** | Retain minimal flex-wrap/boxed neighborhood CSS only; no grid, SVG/canvas, or unrelated restyling. |
| `src/verifier.ts` | **KEEP** | Retain append-only schema extension after `input_fingerprint`, the fourth additive ALTER, and two-column stamp documentation. Do not disturb C027’s incremental-reuse query/insert contract. |

### Dirty test and manifest files

| Dirty verification file | Disposition | Owner reason |
|---|---|---|
| `tests/review-ui.test.ts` | **REWRITE** | Expand from the prototype’s one malformed-input assertion to exact union, grammar, fenced prompt, path citations, byte cap, prefix truncation, refusal, unmapped match, no-spawn, and zero-ledger tests. |
| `tests/ui-acceptance-fixture.test.ts` | **KEEP** | Retain deterministic C002 stale-source proof, but update expected target/count changes only after fixture behavior is stable. |
| `tests/ui-brief.test.ts` | **REWRITE** | Keep P3/generalized-explain/P5 cases and add exact empty/present columns, transitive exclusion, escape, and 390px-safe contract tests. |
| `tests/ui-browser-check.test.ts` | **REWRITE** | Keep seven-page and focus identity coverage; add real multi-control assertion aggregation and ensure causal selectors reflect true `/agent` fixture behavior. |
| `tests/ui-component-contrast.test.ts` | **REWRITE** | Keep fine-grained canonical branches only when every branch is truly rendered by raw fixture inputs; prove no unknown/missing branch and keep both source lists identical. |
| `tests/ui-contrast-manifest.json` | **REWRITE** | Rebuild fixtures and branch declarations from the clean renderer, then mechanically write both verified actual hashes once each. Existing prototype digests are non-authoritative. |

### Untracked non-product prototype artifacts

| Artifact | Disposition | Owner reason |
|---|---|---|
| `docs/logs/implementation-notes-ui-projection.md` | **DELETE** | It records interrupted-prototype claims before the required gates and must not survive as implementation evidence. A new implementation note, if the repository process requires one after successful verification, starts from the clean cutover’s observed evidence. |
| `docs/plans/urtext-20260727-ui-projection-{brief,plan-opus,plan-codex,plan-final}.md` and `.urtext/ui-projection-brief.md` | **KEEP** | These are planning/audit inputs, not product implementation; the owner report is the controlling implementation decision. |

## 3. Exact dogfood contract and document cascade

### C028 — exact text

Append exactly this after committed C027:

```md
## C028 UI 呈现因果与健康投影 <!-- oracle:test:tests/ui-projection.test.ts risk:high refs:specs/urtext/spec.md#C008,specs/urtext/spec.md#C016,specs/urtext/spec.md#C019,specs/urtext/spec.md#C026 req:FR009,FR012 -->

`urtext ui` 必须把七维裁决状态投影成人可直接判读的低维视图，且全部为渲染投影：
不产生第二事实源，不进入 items、counts、WIP 或退出码。

每条 stale 队列项渲染一句因果链——上游变更 key → 本条证据作废 → 重跑 verify 前不放行；
来源取自与 `invalidated_at` 同一次写入的 `invalidation_source`（一枚印章两列），
FR 直接命中的子句归因到该 FR 而非它自身，历史 NULL 行渲染无来源版本，绝不伪造来源。
Your queue 按 feature 单元渲染证据/元审计/高危批准/未覆盖意图的只读健康行。
clause detail 渲染 defended FR ← 本条 → refs 目标 → 直接依赖的一跳邻域（一跳，非闭包）。
approve/decide 控件旁常驻绑定 HEAD 短 sha 与失效规则的静态说明。
AI 解释对每个人车道条款项、unmapped 项与每个成功 clause detail 可用，只读、fail-closed，
其文本永不进入任何账本（R4 红线）。
```

C028’s refs deliberately include C008 (P1 source), C016 (queue/lane semantics), C019 (brief UI), and C026 (FR/detail projection). It has exactly one new high-risk oracle: `tests/ui-projection.test.ts`.

### Task exact text

Append exactly:

```md
- [ ] T019 UI 人类投影：因果链、feature 健康、一跳邻域、AI 解释泛化 <!-- role:coder depends:T018 gate:true clauses:C028 -->
    evidence.invalidation_source 迁移与归因传播、queue 因果句、feature health 只读行、brief 一跳邻域、
    /api/explain queue scope 与全 human-lane 控件、批准语义文案、contrast manifest 与真实 browser acceptance。
```

### C008/C022 recovery

1. Change C008 to the exact wording in §0b and extend `tests/linker.test.ts` before final dogfood verification.
2. Index the changed spec. The C008 text change MUST invalidate C022 because C022 refs C008 (`specs/urtext/spec.md:200-204`).
3. Re-run targeted verification for C008 and C022, then run targeted audit on their **new** evidence IDs; stale evidence is intentionally excluded from audit export (`src/audit.ts:146-172`).
4. Obtain fresh current-HEAD high-risk reviews for C008 and C022 using fresh brief hashes. A prior review is not reusable after their specification/evidence state changed (`specs/urtext/spec.md:173-179`).
5. Only after that recovery may the final full verification and gate claim completion.

## 4. Minimal implementation order

1. **Normative/schema foundation:** C008 wording; C028; T019; `src/verifier.ts` additive source column; `src/linker.ts` labelled attribution and `ImpactReport.directClauses`; unit tests for migration, legacy NULL, C/FR simultaneous causality, no overwrite, and clause-impact byte stability.
2. **Read models:** carry nullable source through `gate.ts` and stale-only optional status field; carry optional source into `BriefManifest`; add P3 refs/direct-dependents from existing impact data; preserve all existing queue/count/WIP/exit contracts.
3. **Render projections:** renderer-owned P1/P2/P5 in console; flex P3/P4/P5 in brief; minimal theme and scripts. Update all strict fixture shapes at the same time.
4. **Explain boundary:** exclusive request parser; manifest-only/status-only bounded facts; untrusted fence, exact headings, response-only `runAgentText`; test every fail-closed branch before UI acceptance work.
5. **Contrast and browser:** fixture matrix and exhaustive branch registry first; compiled actual-hash replacement with exact-once guards; both contrast verifiers; acceptance fixture third commit; browser selector/AX/focus/real-click extensions, still seven pages.
6. **Documentation and recovery:** EN/ZH SYNTAX plus registry/verifier/linker wiki pages; execute C008→C022 recovery; run all final gates.

## 5. Acceptance gates

No gate may be substituted with a narrower look-alike command. A failed gate blocks completion.

### A. Source, behavior, and full suite

1. `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0 under strict and exact optional types.
2. `npm test` exits 0 after all new C028 and existing regression tests run.
3. `sh scripts/full-test.sh` exits 0; this is the required full suite because it performs typecheck, Vitest, build, compiled `node dist/cli.js verify`, and workflow builds (`scripts/full-test.sh:53-70`).
4. The dedicated `tests/ui-projection.test.ts` proves C028 as an isolated high-risk oracle rather than piggybacking C019/C026.

### B. Projection facts

1. A fresh/legacy/migrated evidence database opens successfully. Migration preserves committed `input_fingerprint`; fresh verify still writes it; legacy stale rows retain `invalidation_source IS NULL`.
2. Clause change, FR change, removed-FR path, simultaneous C+FR change, multi-root tie, cycle, and repeat propagation prove source semantics. One stamped row receives both fields in the one UPDATE and is not overwritten.
3. P1 has sourced and legacy rendered sentences; stale remains agent-lane reachable according to `AGENT_ORDER` (`src/status.ts:43-57`), and no source is fabricated.
4. P2 emits exactly one queue-only feature `<ul>` after fail-closed alert, before queue table, one row per feature, links to `/specs`, and reports `n/a (0/0)`. Stale pass and dirty approved high-risk are not healthy numerators. Status JSON/items/counts/WIP/exit remain unchanged except optional raw source on stale item.
5. P3 shows exactly resolved defended FRs, self, manifest refs, and direct dependents; a transitive-only dependent is absent; no new query/dependency/SVG/canvas is introduced; the 390px browser run has no overflow or hidden facts.
6. P5 is adjacent to every actual approve/decide submit control and names its current render-input short SHA plus `代码再动自动失效，需重审`.

### C. Explain, security, and R4 audit

1. `/api/explain` accepts each legal union arm once; key+scope, neither, malformed key, invalid auditor/model, stale/non-current unmapped key, agent item key, malformed JSON, wrong media type, body >4096, bad CSRF, hostile Host, and hostile Origin reject before agent spawn. Security ordering remains the live dispatcher order (`src/ui-server.ts:247-281,315-331`).
2. Clause prompt facts are manifest-only; no rendered brief text, evidence output, review/decision note, or ledger history appears. All scopes contain the untrusted-data fence, tool/write prohibition, exact three headings, and field-path citation instruction.
3. Environment byte-cap validation is tested; large UTF-8 strings cannot exceed the outbound fact budget; queue truncation is per-lane prefix and states its omitted tail.
4. Success, agent failure, and every refusal prove that no row is written to `evidence`, `audit_verdicts`, `reviews`, `decisions`, or any registry table. This is the explicit R4 audit, not an inference from `runAgentText` alone.
5. Normal human clauses, unmapped rows, refused clauses, queue summary, and every successful brief have the prescribed behavior; agent lane has no per-item control.

### D. Contrast and browser gates

1. Before accepting hashes, run both independent contrast implementations: the Vitest manifest verifier and compiled `verifyContrastManifest()` used by `scripts/ui-browser-check.ts:141-167`. Each must report matching source and render digest.
2. The only hash writeback uses compiled actuals and anchored one-match replacement for each of `sourceContractSha256` and `renderContractSha256`; a missing, duplicated, or non-64-hex field throws. No committed writer exists.
3. Fixture matrix reaches every named visible branch using raw inputs, including health internals, sourced and legacy causal, clause/unmapped/queue explain, P5 copy, and P3 present/empty states.
4. Compile the acceptance build outside the repository with `node_modules/.bin/tsc -p scripts/tsconfig.ui-acceptance.json --outDir "$ACC"`; repository and `dist/` remain clean as required by `scripts/ui-acceptance.md:8-29`.
5. Start the compiled acceptance server and run the exact seven-page Chrome/CDP matrix from `scripts/ui-acceptance.md:137-160`: `console`, `agent`, `specs`, `specs-page-2`, `decisions`, `brief`, `error`; 3 viewports × 2 color schemes. Do not add an eighth page.
6. The real fixture’s C001 third commit causes C002 source-stale evidence, and the agent page observes exactly one causal line. Browser checks prove all new selectors/AX links, no horizontal overflow, focus order, reduced motion, contrast ≥4.5, no external requests, correct disclosure, and disabled/re-enabled real clicks for queue, human item, and brief explain controls.

### E. Final recovery, self-hosting, and gate

1. Save a pre-change `node dist/cli.js impact specs/urtext/spec.md#C008` output and compare it byte-for-byte after implementation; the additive `directClauses` must not alter existing clause-impact output.
2. On a clean registry/worktree, run `node dist/cli.js index`, `node dist/cli.js check`, and `node dist/cli.js verify`; C028 must be live and its independent oracle must pass. Verify C008/C022 after their specified cascade, then audit/review both afresh.
3. Run `node dist/cli.js gate`; any expected remaining manual items must be resolved through the real domain guards before a green gate is claimed. Do not equate `status` exit 1 with a failed check: status is intentionally a pending-work signal (`src/cli.ts:418-457`).
4. Final audit records evidence: full suite, dual contrast verification, compiled acceptance fixture/server, seven-page browser report, C008/C022 recovery evidence, C028 own oracle, index/check/verify/gate output, and the byte comparison. No completion claim is valid without all of them.

## 6. Prototype-specific non-acceptance notes

The prototype demonstrates useful direction but is not proof. Its full `git diff HEAD` was reviewed as untrusted, and no result from it is accepted without the gates above. In particular, its new hashes, its unrun browser selector counts, its illustrative prompt helpers, and its product edits are not a substitute for clean implementation, exact tests, or recovery evidence.
