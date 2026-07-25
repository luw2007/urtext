# Urtext UI Design Contract

Canonical UX contract for the operator console (`/`) and clause detail (`/brief`) pages. Sourced from `docs/plans/urtext-20260724-ui-redesign.md`; any change to information architecture, tokens, or the semantic-attribute registry must update this file in the same change (§16).

## 1. Scope & non-goals

In scope: server-rendered console and brief pages, their shared visual/token system, and guarded-action forms. Non-goals: client-side filtering/search, a JS framework, client-side routing or state, build tooling, external fonts/icons/scripts, dashboards (charts, cards, gradients). `>150 clauses` or `>8 specs` are noted as future observation values only — they are not implemented, configured, or tested in this contract (YAGNI, §D6).

## 2. Authority boundary

This file (`DESIGN.md`, repo root) is the single source of truth for UX: information architecture, interaction, accessibility, content, and visual tokens for the two UI pages. `docs/DESIGN.md` remains the architecture authority (module boundaries, data flow, domain layering) and is not duplicated here. Where the two overlap (e.g. a UI module's place in the dependency graph), `docs/DESIGN.md` governs.

## 3. Personas & core loop

Single persona: the **operator** — one person adjudicating spec clauses against code. Core loop: **orient → blocker → evidence/diff → guarded action**. The console must answer "what must I do now" on first paint; the brief page must show enough evidence to decide without leaving the page.

## 4. Information architecture

### 4.1 Console (`/`)

Fixed top-to-bottom order: skip link → header (title, HEAD sha, dirty chip, quit hint) → nav (Your queue · Agent lane · All Specs · 刷新) → main: summary strip → unmapped banner (if any) → Your queue (default-open) → Agent lane (audit controls always visible; lane list collapsed when the human queue is non-empty) → All Specs (grouped by spec path) → Decided manual clauses.

### 4.2 Clause detail (`/brief`)

Fixed order: skip link → header (nav: ← console · 查看全部 Specs · 刷新状态 · ← prev/next →) → clause identity header (spec#clause, title, risk badge, oracle metadata) → evidence status chip → mapping status → Code Blame Diff (per-mapping collapsible) → stale dependencies → raw brief text (collapsed `<details>`) → review actions (only when reviewable). Error pages keep the same shell (skip link, header, nav) with no risk badge.

## 5. Semantic attribute/ID registry

Static IDs: `#main`, `#console-title`, `#your-queue-title`, `#agent-lane-title`, `#all-specs`, `#all-specs-title`, `#decided-title`, `#brief-title`, `#mappings-title`, `#stale-dependencies-title`, `#raw-brief-title`, `#review-title`, `#audit-runner`, `#audit-progress`, `#review-msg`, `#explain-out`, `#workspace-alert-title`, `#error-title`. Dynamic IDs: `spec-group-{index}-title` (0-based render order, one per spec group). `data-*` contracts: `data-banner="unmapped|unmapped-error|wip"`, `data-state="risk-high|risk-low|fresh|stale|no-evidence|dependent-*|error"`, `data-clause="{spec}#{id}"`, `data-section="agent-lane|mappings|stale-dependencies"`, `data-tone="ok|warn|danger|muted|accent"`. Every `aria-labelledby` target above must exist and be unique per render.

## 6. Status vocabulary

Every status is text + symbol + color token — never color alone (§D4).

| Meaning | Symbol | Text | Token | data-state |
|---|---|---|---|---|
| High risk | ⚠ | high | `--danger` | `risk-high` |
| Low risk | — | low | `--muted` | `risk-low` |
| Evidence pass | ✓ | pass / 当前有效 | `--ok` | `fresh` |
| Evidence fail | ✗ | fail | `--danger` | — |
| Pending | ● | pending | `--warn` | — |
| No evidence | ○ | no evidence / 尚无证据 | `--muted` | `no-evidence` |
| Stale | ⚠ | stale / 证据已过期 | `--warn` | `stale` / `dependent-stale` |
| Unmapped/error | ⚠ | (existing copy) | `--danger` | `unmapped` / `unmapped-error` / `error` |

## 7. Visual tokens

`src/ui/theme.ts` (`THEME_CSS`) is the single source. Light and dark palettes, type scale, and spacing all live there — see the file for exact values. No external fonts, icons, or `url()` resources. Component classes and both `data-tone` values share one CSS string across every page.

## 8. Typography & spacing

Type scale: `--fs-s:13px` / `--fs-m:14px` (body) / `--fs-l:16px` / `--fs-xl:20px`; line height `--lh:1.5`. Spacing scale: `--sp-1:4px` through `--sp-6:32px`. Monospace (`--mono`) is reserved for `<code>`, hashes, and diff `<pre>` blocks only — never for prose.

## 9. Accessibility contract

`<html lang="zh-CN">`; exactly one `<h1>` per page; no skipped heading levels. The skip link is the body's first child and the page's first focusable element. Every table has `<caption>` and `<th scope="col">`. All actions are keyboard-reachable; `:focus-visible` shows a 2px accent outline. `aria-live="polite"` on progress/message regions; `role="alert"` on unmapped/refusal banners and error states. No `prompt()`/`alert()` — guarded actions are inline forms with real `<label>`s. `prefers-reduced-motion: reduce` disables all transitions/animations. Any accessibility defect found in browser verification blocks delivery; it is not deferred to implementation notes.

## 10. Responsive contract

Two breakpoints, min-width first: **720px** (nav wraps below this, tables gain `overflow-x:auto`). Never `display:none` a risk badge, evidence status, unmapped banner, guarded-action button, or error message at any width — only reflow, scroll, or a smaller font step. Diff `<pre>` never soft-wraps (alignment over readability); it scrolls horizontally, including on touch.

## 11. Content guidelines

Interface chrome is Chinese; domain terms (clause, oracle, stale, unmapped, brief-hash, Blame Diff) stay in English to match CLI output and spec files — no second vocabulary. Existing copy is preserved verbatim; new copy only fills genuinely new surfaces (counts, truncation notices, group headings). Commands (map/ack/verify/git diff) are single selectable lines using the existing `<...>` placeholder convention.

## 12. Disclosure rules

Your queue is the only default-open work section. Agent lane list is collapsed when the human queue is non-empty, open when it is empty; its audit-run form stays visible regardless. Per-mapping Blame Diff is open when risk is high or the diff is within `config.diffOpenMaxLines`, otherwise collapsed; display truncates at `config.diffDisplayMaxLines`. The raw brief text is always a collapsed `<details>`.

## 13. Security constraints for UI

All dynamic values pass through `esc()` before interpolation — no exceptions. No inline event handlers, no external stylesheets/scripts/fonts/images. Every route enforces Host validation; write routes additionally enforce CSRF token + Origin checks (existing `handleDecide`/`handleReview`/`handleAuditRun` guards are unchanged by this UI layer).

## 14. Thresholds

`UiRenderConfig.diffOpenMaxLines` defaults to `80`; `UiRenderConfig.diffDisplayMaxLines` defaults to `2000`. Overridable via `URTEXT_UI_DIFF_OPEN_MAX_LINES` / `URTEXT_UI_DIFF_DISPLAY_MAX_LINES`; both must parse as positive integers or `readUiRenderConfig` throws (fail-fast, no silent clamping). The `>150 clauses` / `>8 specs` values in §1 are non-runtime design guidance only.

## 15. Testing contract

`src/ui/*.ts` are pure string builders, tested as string contracts (exact escaping, exact element order, exact token presence) without a browser — see `tests/ui-html.test.ts`. Full-page renderers (console/brief, added by later phases) additionally require actual browser/AX verification for keyboard flow and computed contrast; string tests alone do not clear that bar.

## 16. Change protocol

Any change to information architecture, the semantic-attribute/ID registry, the status vocabulary, or visual tokens must update this file in the same commit that makes the change.
