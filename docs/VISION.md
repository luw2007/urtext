# Urtext — Vision and Design Principles

> Status: foundational document. Later design, implementation, and trade-offs defer to this document; changes require an explicit Decision record.

## Position: a vehicle for a paradigm shift, not another language

Software development is moving from manual coding, through AI-assisted conversation and vibe coding, toward a world where humans no longer review ordinary code itself. Urtext is the workbench for that transition: **the human work object moves from code to cognition about the system.**

- Humans maintain system cognition: behavioural specs, visual designs, interaction demos, and acceptance checklists. They are equal first-class artifacts in one cognitive unit.
- AI maintains the projection: code. Code remains fact—like assembly—but no longer consumes routine line-by-line attention.
- **Urtext is the system's ur-text**: the authoritative composer intent; code is an interpretation. Interpretations may vary with LLM randomness, but being out of tune must be decidable.

**The ur-text of your system. Code is just an interpretation.**

## The Assembly-to-C analogy

A real abstraction shift needs four conditions at once:

| # | Assembly → C | AI-era break | Urtext response |
|---|---|---|---|
| 1 | ISA semantics became formal | natural-language specs are undecidable | every normative statement binds an oracle; unverifiable means error |
| 2 | compiler determinism earned trust | the same spec yields different LLM code | move determinism into the verifier: generate → verify → repair |
| 3 | hand-editing compiled output became taboo | code edits do not return to specs | enforce unmapped changes: write back or explicitly acknowledge |
| 4 | DWARF stitches source and machine layers | failures throw people back into code | bidirectional cognition↔code↔evidence mapping; failures name clauses |

Pseudocode is not the answer: it remains in the mechanism (“how”) layer and adds ambiguity. Urtext changes the described object to what the system must satisfy. SQL, Terraform, and type systems have already won this pattern in narrower domains.

## What success looks like

1. Humans review only intent changes, impact scope, acceptance evidence, and disputed items—not routine code line by line.
2. Every normative statement is decidable through one of `test`, `cmd`, `metric`, `diff-scope`, or `manual`.
3. A clause change mechanically reports affected clauses, checklists, and code.
4. Oracle failures name the violated clause, not merely a stack frame.
5. Completion is objective evidence pass rate; AI does not score itself.
6. Humans remain ultimately accountable for intent and intervene only for high risk, cross-domain effects, disagreement, or irreversible operations.

## Principles, ordered by non-negotiability

### P1 — A normative clause without an oracle is an error

This is the boundary between language and documentation. Descriptive prose is free; an oracle-less normative clause fails indexing and cannot execute.

### P2 — Evidence outranks opinion

Completion depends on objective evidence: tests, exit codes, measurements, and diff scope. Cross-model review only asks whether evidence actually covers a clause; it does not replace evidence. Disagreement escalates to a human. Independent ground truth is required because AI-written tests can be internally consistent with AI-written code without proving correctness.

### P3 — The source-of-truth flip needs enforcement, not discipline

Hand edits are permitted, but every hunk not attributable to a clause or dispatch is surfaced as unmapped. It must update a spec or receive an explicit acknowledgement in the Decision ledger. Provenance trusts real diffs, not LLM claims.

### P4 — Risk tiers trigger humans

Low-risk work with green evidence, agreeing meta-verification, and no impact propagation may auto-pass. High-risk, irreversible, cross-history, disputed, or unmapped work requires a human decision recorded durably.

### P5 — The unsafe lane admits the limits of specs

Security boundaries, migrations, concurrency, money paths, and irreversible deletes cannot be fully represented by a spec. On these paths, code remains the only reviewable fact and receives mandatory code-level human review.

### P6 — Format is storage; experience is the surface

Do not invent a file format. Markdown plus HTML-comment anchors carries the clause grammar; describing a system is the product experience.

### P7 — The cognitive unit is multimodal

Clauses, design references, runnable demo snapshots, and checklists link as peers. Design changes should propagate stale state just as text changes do; visual screenshot-diff and interaction-replay oracles are planned first-class extensions.

### P8 — Adopt incrementally, git-native and serverless

Start with `cd` into an existing repository. Urtext requires no runtime, workspace, or orchestration model. It is agent-neutral: it defines a protocol to execute oracles and return evidence, not agent orchestration.

### P9 — The system contains its own falsification condition

The load-bearing assumption is: writing an oracle costs less than line-by-line code review. AI may draft oracles, but humans approve them. If manual-oracle share stays above 50%, the assumption has failed and expansion stops.

## Core vocabulary

| Term | Definition |
|---|---|
| clause | a normative spec statement with a stable ID, oracle, and risk tier |
| oracle | executable decision: `test`, `cmd`, `metric`, `diff-scope`, or `manual` |
| evidence | content-addressed oracle output with a verdict |
| linker | clause registry, cross-spec reference graph, and reverse stale propagation |
| DWARF layer | bidirectional clause↔code↔evidence mapping |
| unmapped change | code change not attributable to a clause; P3's enforcement point |
| unsafe | high-risk marker requiring a human gate and code review |
| meta-verification | an implementation-distinct model audits whether evidence covers clause semantics |

## Non-goals

Urtext does not orchestrate agents, provide formal proof languages, replace Git or CI, provide cloud collaboration/multitenancy, or promise that a good spec alone produces a complete project. It accepts controlled ambiguity where risk and granularity warrant it.
