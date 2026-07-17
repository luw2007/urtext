# Codebase fact distillation

This feature provides the deterministic evidence layer for reverse-engineering an existing codebase into human-reviewed specifications. It discovers observable repository facts and validates declared implementation evidence; it never presents generated prose as authoritative intent.

## C001 Discovery emits a versioned deterministic facts manifest <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C003 -->

Given a workspace containing source, tests, entry points, and existing feature specs,
When `urtext distill discover` runs,
Then it writes `.urtext/distill/facts.json` with a stable schema, the current HEAD, and sorted observed facts without modifying canonical `specs/`.

## C002 Discovery distinguishes observed facts from declared specification links <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C009 -->

Given an existing feature spec with implementation-evidence paths,
When discovery parses the workspace,
Then observed source and test facts remain separately typed from declared feature evidence so a missing declaration cannot be misrepresented as an observed behavioral guarantee.

## C003 Coverage reports actionable declared-to-observed gaps <!-- oracle:test:tests/distill.test.ts risk:low refs:specs/distill/spec.md#C002 -->

Given a facts manifest and feature specs,
When `urtext distill coverage` runs,
Then it reports implementation-evidence files, directories, or globs that do not resolve in the workspace and observed source/test files not owned by any declaration, without assigning unsupported completeness percentages.

## C004 Validation rejects non-existent declared evidence and oracle targets <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C001 -->

Given a feature spec that declares absent implementation evidence or an executable clause whose referenced test file does not exist,
When `urtext distill validate` runs,
Then it accepts existing files, directories, and globs as implementation evidence, reports each invalid declaration, and exits non-zero.

## C005 The CLI documents the distill command family <!-- oracle:test:tests/distill.test.ts risk:low refs:specs/urtext/spec.md#C006 -->

Given a user invokes CLI help,
When the distill feature is present,
Then help documents `distill discover`, `distill coverage`, `distill validate`, and `distill promote` with their output boundary.

## C006 Codebase-to-spec synthesis produces review-only candidates <!-- oracle:cmd:sh%20scripts/oracle-skill.sh%20codebase-to-spec risk:high refs:specs/distill/spec.md#C001,specs/distill/spec.md#C002 -->

Given a current facts manifest,
When the `codebase-to-spec` Skill synthesizes a feature,
Then it writes only staged candidate specs, separates observed facts from inferences, and records evidence gaps rather than inventing behavioral guarantees or canonical specifications.

## C007 Fast promotion only imports observed low-risk runnable candidates <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/distill/spec.md#C006 -->

Given a current codebase-to-spec draft with a facts-manifest HEAD,
When `urtext distill promote` receives a target feature directory,
Then it appends only observed candidates with runnable low-risk oracles and no human-decision marker, retains inferred/manual/high-risk/decision-required candidates in staging, and rejects stale drafts without changing canonical specs.
