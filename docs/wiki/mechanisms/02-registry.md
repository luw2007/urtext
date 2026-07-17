# The Registry

`urtext index` scans your specs and reconciles them into
`.urtext/registry.sqlite` under the workspace root. The registry is not a cache —
it is an **immutable revision chain**, and that immutability is what lets Urtext
answer questions about history without trusting anyone's memory.

## One revision chain per file

Every spec file gets its own chain keyed by `(spec_path, revision)`:

- Each revision records a `content_hash = sha256:<hex>` of the file.
- **Unchanged content is a no-op.** Re-indexing an untouched file adds nothing.
- **Changed content appends a new revision** — either `ready` (clean) or
  `building` (has errors).

The invariant is absolute: **historical revisions are never overwritten.** This
is the storage-layer expression of [flow-forward
persistence](../guides/04-persistence-model.md) — completed revisions are a
permanent record, not an editable scratch area.

> **v0 scope: deletion.** The registry *has* a `tombstoneFile` API that appends a
> `tombstoned` revision with a null content hash, but the scanner only enumerates
> files that still exist and never calls it (`src/scanner.ts`). So in v0, deleting
> a spec file leaves its last revision live rather than tombstoning it — the
> tombstone path is built but not yet wired into `index`.

## Two hashes, two different questions

A clause carries a second hash beyond the file's `content_hash`:

- `content_hash` answers "did the *file* change?" — it covers every byte.
- `text_hash = sha256(heading + body)` is a **prose hash** — it covers the
  clause's title and body text and *excludes* the anchor metadata.

The distinction decides what triggers downstream invalidation. Editing an anchor
field changes `content_hash` but **not** `text_hash`, so it does not propagate
staleness. Read that carefully: it means a change to `oracle`, `oracle_ref`,
`risk`, or `refs` — which can materially change how a clause is verified or what
it depends on — does **not** invalidate downstream evidence, because those live in
the anchor. `text_hash` tracks the prose, not the full semantics. Only a change to
the clause's *text* propagates staleness through the [linker](04-linker-impact.md).

## References are versioned with the chain

Every `refs` edge a clause declares is stored in a `clause_refs` table, versioned
alongside the revision chain. After each scan, the linker resolves references
against the **latest active revision across the whole workspace** — not just the
file being indexed. This is why a dangling reference can be caught: if file A
points at `B#C003` and someone deletes `C003` from B without touching A, only a
whole-workspace pass sees the break. That check therefore belongs to `check`
time, and an `unknown_ref` does not silently corrupt A's own revision state — it
is reported as a validation failure across the workspace.

## Evidence is append-only, invalidation is a flag

The registry's one concession to mutability is narrow and principled. When an
upstream clause's `text_hash` changes, the existing evidence of every clause in
its reverse-dependency closure is stamped with `invalidated_at` — the single
mutable column in the evidence table. Evidence is **never deleted**; it is marked
void and retained for audit. Nothing in Urtext ever erases the record of what was
once checked and how.

With the chain in place, running the oracles and recording their verdicts is the
job of [the verifier](03-verifier.md).
