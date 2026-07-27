# Urtext UI Human-Projection — Owner Contract Brief (round 3)

## Background

`urtext ui` dumps the seven-dimensional clause state `(evidence, audit, review, decision, stale, risk, unmapped)` as flat reason codes, forcing humans to mentally re-run gate.ts:141-173. Humans need high-dimensional state projected into low-dimensional, decision-oriented views. Additionally, the understanding layer cut by decision R4 (docs/plans/urtext-20260720-operator-flow.md:183 — explain command killed, narrative stays out of registry) survives as infrastructure (`/api/explain`, `handleExplain`, `runAgentText`) but renders only one "生成实例说明" button on reviewable high-risk brief pages. This round ships five projections (P1-P5, user-approved design).

## Pinned contract (owner decisions — NOT up for debate)

1. **P1 causal narrative line.** Every human/agent-lane item that is stale renders a one-sentence causal chain, e.g. "FR005 文本变更 → C022 证据作废 → 重跑后需重审".
   - Data gap: `evidence.invalidated_at` has no culprit. Add `invalidation_source TEXT` column (ALTER TABLE ADD COLUMN, append-only history intact, legacy rows NULL). `propagateStale` stamps it with the originating key (`<path>#C<n>` or `<path>#FR<n>`) in the same mutation event as `invalidated_at` — conceptually ONE invalidation stamp, documented as such.
   - Legacy NULL renders the sentence without a culprit ("上游变更 → 证据作废"), never a fake one.
   - docs/SYNTAX.md registry bullet + docs wiki registry/linker mechanism pages updated to name both columns as the single invalidation stamp.
2. **P2 feature health header.** Console page top: one row per feature unit — evidence pass rate, audit agreement, high-risk approved/total, uncovered count — aggregated from EXISTING buildStatus/gate data. Render-only; no new counts enter exit codes, items, or WIP; clicking navigates to the existing spec listing.
3. **P3 one-hop neighborhood on brief page.** From the brief manifest's reqs/refs/impact ONLY (no new queries beyond what the brief already carries or trivially can): defended FRs ← this clause → its refs targets → its direct dependents. Box-drawing HTML/CSS. NO visualization library, NO new dependency, NO svg/canvas.
4. **P4 AI explain generalization** (restore the understanding layer in its R4-sanctioned form):
   - Prompt rewritten from "生成实例" to adjudication-oriented three sections: 为什么需要你 / 批准与拒绝分别意味着什么 / 哪里有风险信号. Facts must come from the brief manifest (traceable), narrative NEVER enters the registry (R4 red line).
   - Explain control extended from "reviewable high-risk brief only" to EVERY human-lane console item (per-item, reusing the clause-key API) and every brief page.
   - New: console "AI 总结当前队列" button — `/api/explain` accepts `{scope:'queue', auditor, model}` alongside the existing `{key,...}` form; handler builds the prompt from the current status snapshot. Same security chain (Host/Origin/CSRF/media-type/body-cap) mandatory.
   - All agent invocations stay read-only, fail-closed, via `runAgentText`. No new endpoint unless the planner proves `/api/explain` overload is worse.
5. **P5 approve-semantics copy.** Next to approve/decide submit controls, static copy naming the bound HEAD short-sha and the invalidation rule ("代码再动自动失效,需重审"). Pure copy + render.
6. **Dogfood**: new clause C027 (UI 呈现因果与健康投影) in specs/urtext/spec.md, `req:FR009,FR012`, risk:high, its OWN oracle test file (MN-6 precedent: never share a high-risk oracle file). tasks.md updated. `urtext index/check/verify` green after migration.
7. **Contrast manifest discipline** (established procedure): any src/ui byte change requires fixtureMatrix updates registering every new visible branch, regeneration via compiled `verifyContrastManifest` actuals + anchored two-field in-place replacement (NO hand-edited hashes, NO new committed writer), both verifiers green. Browser acceptance (7 pages, no 8th) selector tables updated for new sections.
8. **Constraints**: TypeScript strict + exactOptionalPropertyTypes; no new deps; surgical diffs; clause-impact CLI output byte-stable; status JSON may gain OPTIONAL fields only (schema urtext.status/1 extended in place per repo precedent); R4 red line absolute.

## Key code map

- src/linker.ts propagateStale (invalidation UPDATE), src/registry.ts REGISTRY_SCHEMA + openRegistry (ALTER migration pattern — check how grammar_version column was added)
- src/status.ts buildStatus/StatusItem/NEXT_HINT; src/gate.ts adjudicate (health aggregation source)
- src/review-ui.ts handleExplain (prompt template ~line 341-363), buildUiSnapshot; src/ui-server.ts route table + explain path class
- src/ui/render-console.ts, render-brief.ts, brief-script.ts, console-script.ts, contracts.ts, theme.ts
- tests/ui-contrast-manifest.json + tests/ui-component-contrast.test.ts (dual-hash contract); scripts/ui-browser-check.ts (PAGE_SPECIFIC_SELECTORS + second hash implementation)
- tests: review-ui, ui-console, ui-server, ui-brief, ui-html, ui-browser-check, ui-acceptance-*, linker, status
- Prior art: docs/plans/urtext-20260724-ui-redesign.md (state vocabulary, static ID registry, a11y gates), docs/plans/urtext-20260727-fr-observability-plan-final.md (round-2 rulings)

## Deliverable of the PLANNING phase

Technical plan WITH real TypeScript covering:
1. P1 data model: column migration, propagateStale change, causal-sentence composition (where: status? render?), exact code.
2. P2 aggregation + render code; which existing data feeds each cell.
3. P3 neighborhood render code + its data plumbing.
4. P4: new prompt template (full text), explain-control generalization markup/script, queue-scope API shape + validation, security-chain proof.
5. P5 copy + placement.
6. Contrast manifest: every new visible branch enumerated, fixture updates, regeneration steps.
7. Test plan: new oracle file for C027, every existing test touched, browser-acceptance changes.
8. Dogfood: C027 clause text + tasks.md; SYNTAX.md + wiki updates.
9. Risks/edge cases (legacy NULL sources, huge feature counts, explain on items without briefs, queue-summary prompt size caps, i18n of causal sentences).
10. "Weaknesses I know about".

## Constraints (planning phase)

- Read anything; write ONLY your own plan file. No formatters, no test suites.
