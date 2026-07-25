# Domain Baseline — Implementation Notes

- L0 clustering is structural ownership only; it does not infer business behavior or generate normative clauses.
- Every observed source, test, and contract file is assigned once. `platform/<top-level>` is an explicit fallback bucket.
- Contract inventory currently includes `.proto`, `.sql`, `.yaml`, and `.yml`; extensions are intentionally narrow and deterministic.
- `domains.json` is generated under `.urtext/` and remains untracked by default.
