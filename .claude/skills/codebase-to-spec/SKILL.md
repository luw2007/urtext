---
name: codebase-to-spec
description: Convert an existing codebase's Urtext facts manifest into human-reviewable Feature, FR, success-criterion, and executable-clause drafts. Use when asked to derive specs from existing code, reverse-engineer behavior into specs, consume `.urtext/distill/facts.json`, identify specification gaps, or prepare staged code-to-spec drafts without changing canonical specs.
---

# Codebase to Spec

Turn observed repository facts into reviewable specification candidates. The output is a proposal, never a claim that the code is correct or that inferred intent is authoritative.

## Contract

- Read `.urtext/distill/facts.json`; run `urtext distill discover` first when it is absent or its `workspaceHead` differs from `git rev-parse HEAD`.
- Run `urtext distill validate`; stop canonical-spec work on validation errors.
- Treat `observed` facts as code/test inventory and `declared` facts as assertions. Never merge the two.
- Read code and tests before writing a candidate behavior. Prefer tests, state machines, DB constraints, OpenAPI, workflow definitions, and wire contracts over prose.
- Write drafts only under `.urtext/distill/spec-drafts/<feature>/`. Never create or edit `specs/` during synthesis.
- Mark every candidate `observed` or `inferred`. An inferred behavior must name the evidence and the human decision needed.
- Create a clause only for a decidable behavior with an existing oracle. Otherwise record an evidence gap; do not invent a test command or an oracle.
- Do not report a completeness percentage. Report unowned facts and evidence gaps.

## Workflow

### 1. Refresh and inspect facts

```bash
urtext distill discover
urtext distill validate
urtext distill cluster
urtext distill coverage
```

Read the facts manifest and `.urtext/distill/domains.json`. Select one structural domain bucket at a time; its bucket is an L0 ownership boundary, not a claim of product intent. Then read its referenced declarations and the smallest relevant source/test/contract set. Select a feature slice by observable user flow or stable domain behavior, never by file count.

### 2. Establish the fact boundary

Build a short evidence ledger:

| Fact kind | Evidence | Use |
|---|---|---|
| observed behavior | test, state machine, API, workflow, DB constraint | candidate scenario or clause |
| declared link | existing spec implementation evidence | navigation only until verified |
| inference | corroborated but not directly tested behavior | candidate requiring human review |
| gap | implementation without an adequate oracle | evidence gap, not a clause |

Exclude dead code, plans, proposals, demos, and unwired adapters unless a real entry point or test proves the behavior.

### 3. Produce a staged feature draft

Copy [references/draft-template.md](references/draft-template.md) to:

```text
.urtext/distill/spec-drafts/<feature>/spec-draft.md
```

Fill it with:

1. scope and facts-manifest HEAD;
2. observable Given/When/Then scenarios;
3. candidate FRs and success criteria;
4. candidate clauses only where an existing oracle decides the rule;
5. evidence gaps;
6. FR/clause → implementation → test/contract traceability.

Use stable candidate IDs inside the draft. Do not reuse IDs from a canonical feature until a human decides the merge target.

### 4. Feature-level acceptance and promotion

Present one feature-level acceptance covering the draft boundary, vocabulary, and the rule that only observed low-risk candidates with existing workspace-local `test` files or resolvable `cmd` oracles may enter canonical clauses.

Keep inferred requirements, high-risk candidates, manual oracles, weak/broad oracle coverage, unresolved oracles, and evidence gaps in staging. They require a separate strict-lane decision or a stronger machine oracle.

After the feature-level acceptance, promote eligible candidates without per-clause `review`, `audit`, or `map` steps:

```bash
urtext distill promote .urtext/distill/spec-drafts/<feature>/spec-draft.md \
  --target specs/<feature> --confirm
urtext check
urtext verify
```

Promotion is spec-only. A later runtime behavior change still follows the normal impact, review, and audit gates.

## Required output

Report:

```text
Draft: <staging path>
Facts HEAD: <sha>
Observed candidates: <count>
Inferred candidates: <count>
Executable clauses: <count>
Evidence gaps: <count>
Human decisions: <list>
```

Do not state that a draft is an implemented spec, a complete spec, or a source of truth.
