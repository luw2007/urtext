# Domain Baseline Clustering

## Decision

Add `urtext distill cluster` as a deterministic L0 inventory step. It writes `.urtext/distill/domains.json`; it creates no canonical specs or behavioral clauses.

## Inputs

The facts manifest includes observed source, test, and machine-contract files. Contract discovery includes `.proto`, `.sql`, `.yaml`, and `.yml` files outside excluded directories.

## Domain assignment

Each file is assigned exactly once by its structural semantic segment:

- `internal/app/<name>`, `internal/domain/<name>`, and `internal/infra/<name>` → `<name>`;
- `cmd/<name>` → `<name>`;
- `web/src/modules/<name>` → `<name>`;
- `contracts/<name>` or `api/<name>` → `<name>`;
- all other paths → `platform/<top-level>`.

The mapping is transparent structural clustering, not inferred product intent. Output groups each bucket's source, test, and contract files in sorted order.

## L0 completion criterion

A manifest is L0-complete only when every observed file appears in exactly one domain cluster and `unclassified` is empty. `platform/*` is a valid ownership bucket, not a business-domain claim.

## Verification

Unit tests prove deterministic merged domain grouping, contract inclusion, fallback ownership, and exact-once coverage. Target execution records domain count and file totals from the generated manifest.
