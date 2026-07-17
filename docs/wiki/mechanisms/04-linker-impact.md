# The Linker

Change one clause and ask: *what else does this touch?* Every existing
spec-driven tool answers that question with a human reading through documents, or
an LLM guessing. Urtext answers it mechanically, from a graph.

## The reference graph

Every `refs` edge a clause declares becomes an edge in a graph stored in the
`clause_refs` table, versioned with the [registry](02-registry.md)'s revision
chain. `urtext impact` walks that graph in reverse — the *reverse closure* of a
clause — and lists every clause and task that would be affected if it changed.

Here is a real run against this repository's self-hosted spec:

```text
$ urtext impact specs/urtext/spec.md#C004
Affected clauses (reverse closure):
  specs/urtext/spec.md#C008
  specs/urtext/spec.md#C011
  specs/urtext/spec.md#C012
  specs/urtext/spec.md#C013
  specs/urtext/spec.md#C014
Affected tasks:
  specs/urtext/tasks.md T003 oracle runner 与证据库 (cites C004)
  specs/urtext/tasks.md T004 linker 与影响分析 (cites C008)
  specs/urtext/tasks.md T006 元验证协议与风险分级裁决门 (cites C011)
  specs/urtext/tasks.md T007 unsafe lane：高危子句人工代码审查工作流 (cites C013)
  specs/urtext/tasks.md T008 记忆层：manual 子句 Decision ledger (cites C014)
```

That is the impact of touching C004 (the oracle runner clause): five downstream
clauses depend on it, transitively, and each carries the tasks that cite them.
No one read anything. The graph knew.

## Stale propagation invalidates evidence

The graph is not just for queries — it drives invalidation. When a clause's
`text_hash` changes (its title or body text — not its anchor metadata, so an
`oracle`/`risk`/`refs` edit does not trip it), the linker walks the *reverse
closure* and marks every dependent clause `stale`. Each stale clause's existing
evidence is stamped with `invalidated_at`.

This is the concrete answer to *drift during iteration*. In conventional SDD, you
change an upstream requirement and the downstream evidence quietly keeps its old
green mark — it looks verified but is answering a question that no longer exists.
Urtext refuses that: change the meaning of C004 and the evidence of everything
that depends on C004 is automatically void until re-verified. The green is
withdrawn the moment its premise moves.

## Dangling references fail closed

A reference can break without the referencing file changing at all — delete
`C003` from file B and file A's `refs:B#C003` is suddenly pointing at nothing.
Because the linker resolves against the **latest active revision across the whole
workspace**, this dangling reference is caught as an `unknown_ref` at `check`
time, and the command exits non-zero. A reference graph that let edges silently
dangle would be worse than none.

## Why this is the standout capability

Impact analysis is the one thing Urtext does that no existing spec tool does at
all. Spec Kit's change management runs its `analyze` command, an LLM-driven
read-only pass over the current `spec.md` / `plan.md` / `tasks.md`; Urtext's answer
is a graph traversal with a deterministic result.
*Change one clause and get a mechanical answer to "what does this ripple into"* —
that is the independent value the linker ships, and it is the prerequisite for
attributing failures back to intent, which is [DWARF
mapping](05-dwarf-mapping.md).
