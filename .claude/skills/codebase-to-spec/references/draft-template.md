# Feature Specification Draft: <feature>

**Status**: Candidate — not canonical
**Facts manifest**: `.urtext/distill/facts.json` at `<workspace_head>`

## Scope and confidence

- **Observed facts**: <paths/tests/machine contracts>
- **Declared links**: <existing specs and implementation evidence>
- **Inference boundary**: <what requires human confirmation>

## User scenarios

### Scenario 1 — <observable outcome>

**Evidence**: `<test or contract path>`

Given <observable precondition>,
When <observable action>,
Then <observable outcome>.

## Candidate functional requirements

## FR001 <intent>

<Why this behavior must exist.>

  **Evidence**: `<path>`
  **Confidence**: observed | inferred
  **Verification**: `<existing oracle>` | evidence gap

## Candidate clauses

## C001 <decidable behavior> <!-- oracle:<kind>:<ref> risk:<low|high> req:FR<n> -->

<Given/When/Then rule.>

**Evidence**: `<implementation and test paths>`
**Confidence**: observed | inferred
**Human decision needed**: <none | wording | risk | oracle adequacy>

## Evidence gaps

- <behavior that exists but has no executable oracle>

## Traceability

| Candidate | Observed implementation | Test or machine contract | Confidence |
|---|---|---|---|
| <FR/clause> | `<path>` | `<path>` | observed |
