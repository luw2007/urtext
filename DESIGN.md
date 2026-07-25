# Urtext UI Design Contract

Canonical UX contract for the four console-family pages (`/`, `/agent`, `/specs`, `/decisions`) and clause detail (`/brief`). Sourced from `docs/plans/urtext-20260724-ui-redesign.md` and superseded where noted by `docs/plans/urtext-20260725-console-pagination.md`; any change to information architecture, tokens, or the semantic-attribute registry must update this file in the same change (§16).

## 1. Scope & non-goals

In scope: server-rendered console-family and brief pages, their shared visual/token system, pagination, and guarded-action forms. Non-goals: client-side filtering/search, a JS framework, client-side routing or state, build tooling, external fonts/icons/scripts, dashboards (charts, cards, gradients), cursor pagination, or numeric page windows. `>150 clauses` or `>8 specs` are future observation values only — they are not implemented, configured, or tested in this contract (YAGNI, §D6).

## 2. Authority boundary

This file (`DESIGN.md`, repo root) is the single source of truth for UX: information architecture, interaction, accessibility, content, and visual tokens for these five UI pages. `docs/DESIGN.md` remains the architecture authority (module boundaries, data flow, domain layering) and is not duplicated here. Where the two overlap (e.g. a UI module's place in the dependency graph), `docs/DESIGN.md` governs.

## 3. Personas & core loop

Single persona: the **operator** — one person adjudicating spec clauses against code. Core loop: **orient → blocker → evidence/diff → guarded action**. The console must answer "what must I do now" on first paint; the brief page must show enough evidence to decide without leaving the page.

## 4. Information architecture

Each console-family page has exactly one main list region. When non-empty it contains exactly one `<table>`; `/`, `/agent`, and `/decisions` keep their empty copy inside the table body, while `/specs` renders `no live clauses` outside a table.

### 4.1 Your queue (`/`)

Fixed order: shared shell → summary strip → compact unmapped status → paginated human queue. Unmapped remediation commands live only in the corresponding queue rows.

### 4.2 Agent lane (`/agent`)

Fixed order: shared shell → compact unmapped status → audit result, when present → always-visible audit form → deduplicated next-hint list for the current page → paginated agent queue. The audit form is disabled with an explicit empty state when no evidence is auditable.

### 4.3 All Specs (`/specs`)

Fixed order: shared shell → compact unmapped status → paginated live clauses. A non-empty page uses one table with contiguous spec paths represented as `<tbody data-spec>` row groups; the empty state is `no live clauses` without a table.

### 4.4 Decided (`/decisions`)

Fixed order: shared shell → compact unmapped status → paginated decided manual clauses at HEAD.

### 4.5 Clause detail (`/brief`)

Fixed order: skip link → header (nav: ← console · 查看全部 Specs · 刷新状态 · ← prev/next →) → clause identity header (spec#clause, title, risk badge, oracle metadata) → evidence status chip → mapping status → Code Blame Diff (per-mapping collapsible) → stale dependencies → raw brief text (collapsed `<details>`) → review actions (only when reviewable). Error pages keep the same shell (skip link, header, nav) with no risk badge. `查看全部 Specs` links to `/specs`.

## 5. Semantic attribute/ID registry

Static IDs: `#main`, `#console-title`, `#your-queue-title`, `#agent-lane-title`, `#all-specs`, `#all-specs-title`, `#decided-title`, `#brief-title`, `#mappings-title`, `#stale-dependencies-title`, `#raw-brief-title`, `#review-title`, `#audit-runner`, `#audit-progress`, `#audit-result`, `#review-msg`, `#explain-out`, `#error-title`. `#agent-lane-title` is an `<h2>` id. `data-*` contracts: `data-banner="unmapped|unmapped-error|wip"`, `data-state="risk-high|risk-low|fresh|stale|no-evidence|dependent-*|error"`, `data-row="{queue-or-decision-key}"`, `data-spec="{spec-path}"`, `data-clause="{spec}#{id}"`, `data-section="mappings|stale-dependencies"`, `data-tone="ok|warn|danger|muted"`. Navigation contracts: `nav[aria-label="页面导航"]`, `nav[aria-label="分页"]`, `a[rel="prev"|"next"]`, and exactly one `aria-current="page"` in the page navigation. Every `aria-labelledby` target must exist and be unique per rendered page.

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

## 7. Visual language and tokens

The visual direction is Google Cloud Console + Workspace: restrained product chrome, clear surface hierarchy, compact data density, and prominent but calm interaction states. This is an interaction-language reference, not Google branding: Urtext uses no Google logo, proprietary icon, external font, stylesheet, script, or asset.

`src/ui/theme.ts` (`THEME_CSS`) remains the single source. The page canvas uses `--canvas`; the application bar, destination navigation, and primary content use `--surface`; supporting controls and headers use `--surface-container` / `--surface-container-high`. `--primary`, `--primary-container`, `--on-primary`, and `--on-primary-container` define actions and active destinations. Light and dark palettes are complete. The committed bidirectional contrast manifest names every visible selector-to-role pair and resolves each pair in both themes; the real Chrome matrix independently checks computed foreground/background contrast.

Shape/elevation are restrained: fields and alerts use 8px radii, tables/forms/details use 12px, and the page surface uses 16px plus one low elevation shadow. Status, destination-navigation, and pagination controls use pill geometry to identify compact states and destinations. No gradient, glass effect, decorative illustration, or ornamental motion. The optional table-row hover tint uses `color-mix()` (Chrome 111+, Safari 16.2+, Firefox 113+); older engines safely omit only that decorative tint.

## 8. Typography, spacing, and component density

Arial/Helvetica/system sans provides the familiar Google-product density without downloading Google Sans or Roboto. Type scale: `--fs-s:13px` / `--fs-m:14px` (body) / `--fs-l:16px` / `--fs-xl:22px`; line height `--lh:1.5`. Spacing remains `--sp-1:4px` through `--sp-6:32px`. Monospace (`--mono`) is reserved for code, hashes, paths, commands, and diff blocks.

The 64px application bar owns product identity and runtime metadata. The destination nav uses 40px links with an explicit primary-container current state. Native inputs, selects, textareas, and buttons have a 44px minimum interaction height; forms are outlined supporting surfaces. Tables use one outlined rounded container, a surface-container header, 52px rows, and a subtle hover tint. Status chips have consistent 24px height, padding, radius, and weight. Pagination is a separated footer toolbar whose previous/next actions and state remain visible at every viewport.

## 9. Accessibility contract

`<html lang="zh-CN">`; exactly one `<h1>` per page; no skipped heading levels. The skip link is the body's first child and the page's first focusable element. Every table has `<caption>` and `<th scope="col">`. All actions are keyboard-reachable; `:focus-visible` shows a 2px accent outline. `aria-live="polite"` on progress/message regions; `role="alert"` on unmapped/refusal banners and error states. No `prompt()`/`alert()` — guarded actions are inline forms with real `<label>`s. `prefers-reduced-motion: reduce` disables all transitions/animations. Any accessibility defect found in browser verification blocks delivery; it is not deferred to implementation notes.

## 10. Responsive contract

Two breakpoints, min-width first: **720px** (nav wraps below this, tables gain `overflow-x:auto`). Never `display:none` a risk badge, evidence status, unmapped banner, guarded-action button, error message, or pagination control at any width — only reflow, scroll, or a smaller font step. Diff `<pre>` never soft-wraps (alignment over readability); it scrolls horizontally, including on touch.

## 11. Content guidelines

Interface chrome is Chinese; domain terms (clause, oracle, stale, unmapped, brief-hash, Blame Diff) stay in English to match CLI output and spec files — no second vocabulary. Existing copy is preserved verbatim; new copy only fills genuinely new surfaces (counts, truncation notices, group headings). Commands (map/ack/verify/git diff) are single selectable lines using the existing `<...>` placeholder convention.

## 12. Disclosure rules

Console-family lists are separate pages rather than disclosures. The audit form is always visible on `/agent`; when no evidence is auditable its submit button is disabled and an explicit empty-state message remains visible. Per-mapping Blame Diff is open when risk is high or the diff is within `config.diffOpenMaxLines`, otherwise collapsed; display truncates at `config.diffDisplayMaxLines`. The raw brief text is always a collapsed `<details>`.

## 13. Security constraints for UI

All dynamic values pass through `esc()` before interpolation — no exceptions. No inline event handlers, no external stylesheets/scripts/fonts/images. Every route enforces Host validation; write routes additionally enforce CSRF token + Origin checks (existing `handleDecide`/`handleReview`/`handleAuditRun` guards are unchanged by this UI layer).

## 14. Thresholds

`UiRenderConfig.diffOpenMaxLines` defaults to `80`; `UiRenderConfig.diffDisplayMaxLines` defaults to `2000`. Overridable via `URTEXT_UI_DIFF_OPEN_MAX_LINES` / `URTEXT_UI_DIFF_DISPLAY_MAX_LINES`; both must parse as positive integers or `readUiRenderConfig` throws (fail-fast, no silent clamping). Console-family pagination defaults to 20 items per page and can be overridden by positive-integer `URTEXT_UI_PAGE_SIZE`; this is server/UI-internal configuration and is not part of the public `UiRenderConfig` contract. The `>150 clauses` / `>8 specs` values in §1 are non-runtime design guidance only.

## 15. Testing contract

`src/ui/*.ts` are pure string builders, tested as string contracts (exact escaping, exact element order, exact token presence) without a browser — see `tests/ui-html.test.ts`. Full-page renderers additionally require browser/AX verification for keyboard flow and computed contrast. The console-family matrix uses page names `console`, `agent`, `specs`, `specs-page-2`, and `decisions`; brief and error retain their own page names. String tests alone do not clear that bar.

## 16. Change protocol

Any change to information architecture, the semantic-attribute/ID registry, the status vocabulary, or visual tokens must update this file in the same commit that makes the change.
