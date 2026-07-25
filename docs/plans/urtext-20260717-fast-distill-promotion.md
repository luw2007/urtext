# Fast Distill Promotion

## Decision

`urtext distill promote <draft> --target <feature>` promotes codebase-to-spec drafts without routing every imported fact through the behavioral-change unsafe lane.

## Eligibility

Promote a candidate only when all conditions hold:

- `Confidence: observed`;
- its clause anchor is `test` with an existing workspace-local test file, or `cmd` with a resolvable executable command;
- `risk:low` or no explicit risk marker;
- no pending `Human decision needed` marker (`none` is not pending).

Promotion never executes staged commands. The canonical `urtext verify` step runs promoted oracles.

Retain candidates in staging when they are inferred, have an evidence gap, use a manual oracle, are high risk, require a human decision, or have an unresolved oracle.

## Inputs and outputs

- Input draft is under `.urtext/distill/spec-drafts/` and carries a facts-manifest HEAD.
- Promotion rejects a stale draft when that HEAD differs from current Git HEAD.
- Target is `specs/<feature>/`; the command appends eligible clause blocks to `clauses.md` and returns a report of promoted and retained candidates.
- It never overwrites `spec.md`, does not map code, and does not write reviews, decisions, or audit verdicts.

## Human boundary

The caller's single feature-level confirmation authorizes promoting the eligible observed candidates. Strict review/audit remains for later runtime behavior changes and for candidates retained by this command.

## Verification

Unit tests cover promotion of an eligible observed low-risk candidate; retention of inferred, manual, high-risk, and human-decision candidates; stale facts rejection; and stable report output. `urtext check` validates the resulting canonical clauses.
