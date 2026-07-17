# Urtext System Design (Seven Subsystems)

> This document is the authoritative structural description of Urtext. `VISION.md` defines principles; `SYNTAX.md` defines grammar.

## Overview

```text
intent → spec (clause + oracle) → link (impact analysis) → human spec-diff review → accept
       → materialized checklist → AI generation (with provenance) → oracle execution (evidence)
       → cross-model meta-verification → risk-tier gate → merge → Decision/ADR record
```

| # | Subsystem | Responsibility | v0 status |
|---|---|---|---|
| 1 | Language layer | `clause` / `oracle` / `refs` / `risk` primitives (`SYNTAX.md`) | parser + fail-closed error catalogue |
| 2 | Registry | immutable revision chain (`unchanged` / `indexed` / `tombstoned`) | `registry.sqlite` |
| 3 | Verifier | execute oracles → persist evidence → compute completion | `urtext verify` |
| 4 | Linker | build `refs` graph, propagate stale state, `urtext impact` | `urtext impact` |
| 5 | DWARF | clause↔code↔evidence mapping; unmapped-change detection | `urtext map/ack/blame`, `check --diff` |
| 6 | Adjudication | risk-tier human routing, cross-model meta-verification, unsafe-lane review | `urtext audit/gate/review` |
| 7 | Memory | persist Decisions/ADRs | `urtext decide/decisions` |

## Non-reversible design decisions

1. **A normative clause without an oracle is an indexing error** (P1): this is the boundary between a language and a document.
2. **Completion equals evidence pass rate**; AI does not score itself (P2). Cross-model adversarial review exists only at the meta layer.
3. **The source-of-truth flip requires enforcement** (P3): every unmapped change must either update a spec or receive an explicit acknowledgement.
4. **Risk tiers trigger humans** (P4): low-risk all-green work can pass automatically; high-risk, disputed, or unmapped work requires review.
5. **The unsafe lane acknowledges the limit of specifications** (P5): money paths, migrations, and concurrency still require code-level human review.
6. **Manual-oracle share is a health metric** (P9): sustained share above 50% falsifies the central assumption.

## Verifier (v0 implementation boundary)

`urtext verify` indexes, selects clauses from every `ready` revision, executes their oracles, persists evidence, and reports results.

| Oracle kind | Execution | Verdict |
|---|---|---|
| `test` | `npx vitest run <ref>` | exit code 0 → pass |
| `cmd` | execute `<ref>`; `%20` separates arguments, e.g. `scripts/x.sh%20arg` | exit code 0 → pass |
| `diff-scope` | compare `git diff --name-only HEAD` against the allowed glob | no violations → pass |
| `manual` | does not execute | pending; waits for a human and counts toward manual share |
| `metric` | unsupported in v0 | fail explicitly; never silently skip |

Exit status: any failure returns 1; pending does not block. A human decides a manual clause through `urtext decide`, which writes to the Decision ledger (the memory layer).

Evidence is append-only:

```text
evidence(spec_path, revision, clause_id, oracle_kind, oracle_ref, verdict,
         exit_code, output, created_at)
```

## Self-hosting loop

Urtext describes itself. `specs/urtext/spec.md` declares the system's core clauses, each bound to a real oracle from this repository; `specs/urtext/tasks.md` maps implementation tasks to those clauses. `urtext check && urtext verify` being green is the minimum proof that the design loop closes.
