# Urtext FR Observability — Owner Contract Brief (round 2)

## Background

The requirement layer landed in commit 6c8afb5: FR declarations, mandatory `req:` bindings, check-stage enforcement, stale propagation, `counts.uncovered` in status. Two surfaces were explicitly deferred by the round-1 adjudication (docs/plans/urtext-20260726-req-layer-plan-final.md, rulings 8 note & 12):

1. The FR-direction graph is unqueryable: "which clauses defend FR007" has no command (Plan A self-declared weakness 8).
2. The UI shows nothing about req bindings or uncovered intent (ruling 12: src/ui/ zero bytes, deferred to its own change — precisely because Plan B underestimated the contrast-manifest blast radius).

This round delivers both.

## Pinned contract (owner decisions — NOT up for debate)

1. **`urtext impact` accepts FR targets**: `urtext impact <spec-path>#FR<n>`.
   - Semantics: mechanical readout, no judgment. Direct = every live clause whose resolved req edge (bare unit-local or explicit path form) targets that FR. Affected closure = existing reverse `clause_refs` closure seeded by those direct clauses (direct clauses included in output, distinguishable from transitive ones). Tasks = checklist tasks citing any affected clause, same as clause impact today.
   - Nonexistent/tombstoned FR target → clear error, exit 1. Ambiguous is impossible for an explicit `path#FR<n>` target; bare targets are NOT accepted on the CLI (a CLI target is always `path#id` — same as clause impact today).
   - Existing `impact <path>#C<n>` behavior byte-for-byte unchanged. Usage/help text updated; `docs/wiki` command reference stays consistent (C015 oracle greps `urtext impact` — keep it passing).
2. **UI gains two read-only surfaces** (first bytes into `src/ui/` since the FR layer):
   - Clause detail: the clause's `req:` bindings rendered with resolved FR title; dangling/ambiguous bindings show an explicit broken state (style-consistent with C019's explicit-state discipline). Plus a "defended by" reverse hint is NOT required (impact command covers it).
   - Console/queue page: an "Uncovered intent" section listing uncovered FRs (spec path, FR id, title) with an explicit empty state. Data comes from the existing status pipeline (`uncoveredRequirements`, `counts.uncovered`) — no new adjudication semantics, no exit-code changes, nothing enters items/WIP.
3. **Contrast-manifest regeneration is IN SCOPE and must be planned precisely.** `tests/ui-contrast-manifest.json` is committed and hash-validated against renderer/theme sources (tests/ui-component-contrast.test.ts: sourceContractSha256 / renderContractSha256, visible-branch coverage, token-pair registration). Any new visible UI branch must be registered per the existing mechanism. The plan MUST name the exact regeneration procedure used by this repo (find it: docs/plans/urtext-20260724-ui-redesign.md and scripts/) — hand-editing hashes is prohibited. Browser acceptance (scripts/ui-acceptance.md flow, ui-browser-check) must pass for the changed pages.
4. **New dogfood clauses** in specs/urtext/spec.md:
   - C025 (FR impact queryable) `req:FR013`, oracle:test bound to the linker/cli tests defending the new query; risk low.
   - C026 (UI renders req bindings + uncovered intent) `req:FR012`, oracle:test, risk high (same lane as C019).
   - tasks.md gains a task citing them. `urtext index/check/verify` green after migration.
5. **No grammar changes.** SYNTAX.md untouched. No new dependencies. strict + exactOptionalPropertyTypes. Surgical diffs.
6. **status JSON schema unchanged** (`urtext.status/1` already carries what the UI needs). UI server may add endpoints/props to its own contracts (src/ui/contracts.ts) as the existing pattern dictates.

## Key code map

- `src/linker.ts` — impact() (clause reverse closure), liveGraph, resolveReq/uncoveredRequirements from round 1
- `src/cli.ts` — impact command (~line 647), usage text, command allowlist
- `src/ui/` — contracts.ts, html.ts, render-console.ts, render-brief.ts, theme.ts, console-script.ts, brief-script.ts
- `src/ui-server.ts`, `src/review-ui.ts` — server/data plumbing
- `tests/ui-contrast-manifest.json` + tests/ui-component-contrast.test.ts — committed contrast contract
- `tests/spec-impact-interactions.test.ts`, `tests/ui-console.test.ts`, `tests/ui-server.test.ts`, `tests/ui-html.test.ts`, `tests/ui-browser-check.test.ts`, `tests/ui-acceptance-*.test.ts`
- `docs/plans/urtext-20260724-ui-redesign.md` — the UI architecture + manifest mechanism this must follow
- Round-1 artifacts: docs/plans/urtext-20260726-req-layer-plan-final.md, docs/logs/implementation-notes-req-layer.md

## Deliverable of the PLANNING phase

A technical plan WITH core code (real TypeScript) covering:
1. Impact: linker API shape (new function vs extended impact()), CLI parsing of FR targets, output format, exact code.
2. UI: data flow from registry/status to rendered HTML for both surfaces; contracts.ts changes; exact render code; which pages/selectors change.
3. Contrast manifest: exact regeneration procedure, which entries change, how visible-branch coverage stays complete.
4. Test plan: which existing tests change; new tests defending C025/C026; browser-acceptance impact.
5. Dogfood: C025/C026 clause text + tasks.md addition.
6. Risks/edge cases (FR with zero clauses in detail view, dangling req rendering, huge FR fan-out, pagination interactions).
7. "Weaknesses I know about" section.

## Constraints

- Planning only: read anything, modify nothing except your own plan file.
- Do NOT run formatters, linters, or test suites during planning.
