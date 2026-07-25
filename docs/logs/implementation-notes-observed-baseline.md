# Observed Executable Baseline — Implementation Notes

- L1 baseline groups are evidence claims, not product-behavior claims: each group only states that named existing tests can run at the recorded HEAD.
- Go groups run per package; Go 1.25 workspaces receive `GOTOOLCHAIN=go1.25.0`. Web groups use the workspace's `pnpm --dir web vitest run` command.
- The generator emits gaps only for source/contract files in domains with no test group. It does not claim line or behavioral coverage.
- `baseline validate` is structural and non-executing. `baseline run` writes generated evidence under `.urtext/distill/`.
