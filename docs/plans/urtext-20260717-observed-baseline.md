# Observed Executable Baseline

## Decision

`urtext distill baseline` writes `.urtext/distill/baseline.json`, an L1 observed-evidence artifact derived only from the L0 domain inventory. It does not modify canonical specs.

## Clauses

Each domain's test files form deterministic executable groups:

- Go tests: one group per `(domain, Go package directory)` using `go test ./<package>` with `GOTOOLCHAIN=go1.25.0` when the workspace declares Go 1.25.
- Web TypeScript tests: one group per `(domain, web module directory)` using `pnpm --dir web vitest run <relative tests>`.
- Other TypeScript tests: one group per `(domain, test directory)` using `npx vitest run <tests>`.

A group is an observed clause: its assertion is only that the named test files are executable evidence at the manifest HEAD. It does not restate or elevate their implied product behavior.

## Validation

`urtext distill baseline validate` confirms current facts and domains have matching HEADs, every observed test appears in exactly one group, each group has an executable command, and source/contract files without a domain test group are reported as gaps. It does not execute tests.

`urtext distill baseline run` executes generated groups with direct argv invocation, reports pass/fail per group, and writes `.urtext/distill/baseline-evidence.json`.
