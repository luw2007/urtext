# Console pagination implementation notes

Date: 2026-07-26
Normative plan: `docs/plans/urtext-20260725-console-pagination.md`

- Kept pagination as a renderer/server projection over one complete `UiSnapshot`; no domain query, schema, or ordering changes.
- Kept generated navigation to previous/next only. If real repositories routinely exceed 10 pages, reassess numeric page jumps; until then their CSS, focus, ellipsis, and responsive contracts are unnecessary.
- Kept Decided ordering in existing `spec_path, seq` order rather than decision time. This preserves snapshot order and avoids creating a second ordering contract.
- `URTEXT_UI_PAGE_SIZE` is fail-fast internal server configuration. It was deliberately excluded from public `UiRenderConfig`, `startUiServer` options, and the root export surface.
- Page bounds clamp to the last available page without redirects. This keeps one request ledger record per request and lets a reload survive data shrinking under an old bookmark.
- Pagination does not provide cross-request snapshot isolation. The loopback, single-operator console accepts a row shifting between pages after a concurrent ledger update.
- Final real Chrome/cmux execution and real C019 auditor/review actions remain parent-owned by explicit implementation constraint; automated matrices and external acceptance compilation are completed here.
