# Key Decision Record

> Conclusions from the July 2026 founding discussion that do not belong in `VISION.md` or `DESIGN.md`. Each section stands independently; overturning one requires new evidence rather than silent drift.

## D1 Market position

| Tool family | What it does | Gap Urtext addresses |
|---|---|---|
| Spec Kit / OpenSpec / Kiro | spec templates and SDD flows | statements are not decidable; no oracle, linker, or DWARF mapping |
| CodeRabbit CLI | local uncommitted-diff review and repair loops | operates at the code layer; it does not carry intent or acceptance closure |
| Claude Agent Teams / Codex App | parallel agents, worktrees, task sharing | orchestration does not decide whether generated work is correct |
| Gastown | large-agent orchestration, merge queues, quality trends | measurement-only review; complementary rather than a replacement |

The gap is a decidable loop from intent through code to evidence.

## D2 Licence boundary

Urtext is new MIT software, built from scratch, without a browser-runtime dependency.

## D3 The same-origin verification trap

AI-generated tests verifying AI-generated implementations prove only consistency with one interpretation of a spec. A second SOTA model may share the same misunderstanding. The remedy is independent ground truth: objective oracle evidence. Cross-model review remains meta-verification only: it asks whether evidence covers clause semantics, never replaces evidence. Implementation and audit presets must differ; disagreement escalates to a human and is never swallowed.

## D4 DWARF enforcement

Mappings persist clause ID, spec path, file range, and commit SHA. A claimed mapping is stored only if it intersects the real diff at that time: provenance trusts the diff, not the LLM. Every unmapped hunk must either write back a new spec clause or receive an explicit Decision acknowledgement. Failures map from evidence through code to a clause, rather than stopping at a stack frame.

## D5 The complete Assembly-to-C analogy

Beyond the four conditions in VISION:

5. An abstract machine preserves its cost model. Urtext exposes risk, latency, blast radius, and reversibility instead of hiding danger behind abstraction.
6. An escape hatch exists. `risk:high` and the unsafe lane are equivalent to `inline asm`: they acknowledge cases where abstraction must yield to code-level review.

Pseudocode is not an answer: it is still mechanism, increases ambiguity, and loses code's executability.

## D6 Metaphor system

| Urtext publishing practice | System counterpart |
|---|---|
| ur-text is authoritative; a performance interprets it | spec is the source of truth; code is projection |
| performances vary | LLM generations vary |
| being out of tune is decidable | oracle |
| critical apparatus records provenance | evidence plus provenance |
| editorial change must be marked | unmapped-change enforcement |
| compare manuscripts to establish text | cross-model meta-verification |

The human is conductor, AI agents are players, code is performance, and the oracle is tuning fork. Urtext is the score on the podium, not the conductor.

## D7 Spec-coding anti-patterns

| Anti-pattern | Discipline-only response | Urtext mechanism |
|---|---|---|
| vague gates such as “fast” | templates and review rules | P1: no oracle is a syntax error |
| spec rot after implementation | cleanup instructions | D4 unmapped-change enforcement |
| spec drift during iteration | manual synchronization | linker stale propagation plus `urtext impact` |
