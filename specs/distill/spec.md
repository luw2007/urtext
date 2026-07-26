# Codebase fact distillation

This feature provides the deterministic evidence layer for reverse-engineering an existing codebase into human-reviewed specifications. It discovers observable repository facts and validates declared implementation evidence; it never presents generated prose as authoritative intent.

## Requirements (FR)

Requirements state why this feature must exist; clauses state how each one is
mechanically defended. A requirement is intent and never decidable — an
`oracle:` or `risk:` field on one is an indexing error.

### FR001 Generated prose must never pass as human intent

Reverse-engineering a codebase produces plausible sentences. Unless observed
facts stay typed apart from inferences, a guess becomes an authoritative
behavioral guarantee the moment someone reads it.

### FR002 Observed facts must be deterministic and recomputable

A manifest that varies between runs cannot ground anything. Discovery must emit
a stable, sorted, HEAD-stamped artifact that a second run reproduces exactly.

### FR003 Declared evidence must resolve in the real repository

A specification pointing at files that do not exist is worse than no
specification: it reports coverage it does not have.

### FR004 Nothing reaches canonical specs without an explicit human act

Automation may stage candidates; only a human may make one canonical. Anything
inferred, manual, high-risk, or decision-bearing stays in staging.

### FR005 The command family must document its own output boundary

Every distill command must say, in help, what it writes and what it refuses to
write — otherwise "never modifies canonical specs" is an unverifiable promise.

## C001 Discovery emits a versioned deterministic facts manifest <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C003 req:FR002 -->

Given a workspace containing source, tests, entry points, and existing feature specs,
When `urtext distill discover` runs,
Then it writes `.urtext/distill/facts.json` with a stable schema, the current HEAD, and sorted observed facts without modifying canonical `specs/`.

## C002 Discovery distinguishes observed facts from declared specification links <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C009 req:FR001 -->

Given an existing feature spec with implementation-evidence paths,
When discovery parses the workspace,
Then observed source and test facts remain separately typed from declared feature evidence so a missing declaration cannot be misrepresented as an observed behavioral guarantee.

## C003 Coverage reports actionable declared-to-observed gaps <!-- oracle:test:tests/distill.test.ts risk:low refs:specs/distill/spec.md#C002 req:FR003 -->

Given a facts manifest and feature specs,
When `urtext distill coverage` runs,
Then it reports implementation-evidence files, directories, or globs that do not resolve in the workspace and observed source/test files not owned by any declaration, without assigning unsupported completeness percentages.

## C004 Validation rejects non-existent declared evidence and oracle targets <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/urtext/spec.md#C001 req:FR003 -->

Given a feature spec that declares absent implementation evidence or an executable clause whose referenced test file does not exist,
When `urtext distill validate` runs,
Then it accepts existing files, directories, and globs as implementation evidence, reports each invalid declaration, and exits non-zero.

## C005 The CLI documents the distill command family <!-- oracle:test:tests/distill.test.ts risk:low refs:specs/urtext/spec.md#C006 req:FR005 -->

Given a user invokes CLI help,
When the distill feature is present,
Then help documents `distill discover`, `distill coverage`, `distill validate`, `distill cluster`, `distill baseline`, and `distill promote` with their output boundary.

## C006 Codebase-to-spec synthesis produces review-only candidates <!-- oracle:cmd:sh%20scripts/oracle-skill.sh%20codebase-to-spec risk:high refs:specs/distill/spec.md#C001,specs/distill/spec.md#C002 req:FR001,FR004 -->

Given a current facts manifest,
When the `codebase-to-spec` Skill synthesizes a feature,
Then it writes only staged candidate specs, separates observed facts from inferences, and records evidence gaps rather than inventing behavioral guarantees or canonical specifications.

## C007 Fast promotion only imports observed low-risk runnable candidates <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/distill/spec.md#C006 req:FR004 -->

Given a current codebase-to-spec draft with a facts-manifest HEAD,
When `urtext distill promote` receives a target feature directory,
Then it appends only observed candidates with runnable low-risk oracles and no human-decision marker, retains inferred/manual/high-risk/decision-required candidates in staging, and rejects stale drafts without changing canonical specs.

## C008 Domain clustering inventories every observed code, test, and contract file <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/distill/spec.md#C001 req:FR002 -->

Given a current facts manifest,
When `urtext distill cluster` runs,
Then it writes a deterministic domain manifest in which every observed source, test, and machine-contract file belongs to exactly one transparent structural domain bucket without asserting product intent.

## C009 Observed baseline groups every executable test without inferring behavior <!-- oracle:test:tests/distill.test.ts risk:high refs:specs/distill/spec.md#C008 req:FR002 -->

Given a current facts manifest and domain inventory,
When `urtext distill baseline` runs,
Then it writes deterministic observed test groups with direct executable commands, assigns every observed test exactly once, and reports source or contract files with no domain test group as gaps rather than asserting behavior.
