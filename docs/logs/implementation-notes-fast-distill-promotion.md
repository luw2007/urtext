# Fast Distill Promotion — Implementation Notes

- Feature-level `--confirm` is the only human acceptance for spec-only promotion. Runtime behavior changes remain on the existing strict lane.
- Promotion retains rather than fails candidates that are inferred, manual, high risk, decision-required, or have unresolved test/cmd oracle references.
- Promotion checks command resolvability but never executes commands from staged drafts. `urtext verify` executes the promoted canonical oracle after writeback.
- Relative `cmd` paths must remain inside the workspace and be executable. Test paths must remain workspace-local.
- Canonical `spec.md` is never rewritten; eligible clauses append to `clauses.md` after duplicate-ID checks across the target feature.
