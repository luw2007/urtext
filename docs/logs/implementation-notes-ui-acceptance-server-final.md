# Implementation notes — ui-acceptance-server-final

Task: close two audited acceptance gaps for the S4 acceptance fixture
(urtext-20260724-ui-redesign §§6.3 item 8, 8.2, 8.3.2–8.3.5, 9.1) by adding a
compiled, deep-imported internal HTTP server helper that a real browser/HTTP
acceptance matrix can drive against local, non-network agent stubs.

## What was added

- `scripts/ui-acceptance-server.ts` — compiled-only helper, deep-imports
  `startUiServerWithDeps` (not the public `startUiServer`). CLI: `--root
  <fixture-root>`. Opens the fixture's own `.urtext/registry.sqlite`, builds
  a `.urtext/ui-agent-stubs/` wrapper bundle via `createAgentStubBundle`
  (using its own compiled sibling `ui-agent-stub.js`), starts the server on
  port 0 / `open:false` / `decider:'ui-acceptance'`, injects a `spawnAsync`
  that routes the exact command name a real `AuditorId` resolves to
  (`claude`/`codex`/`traecli`/`omp`) onto the matching local wrapper. Prints
  one readiness JSON line, then on SIGINT or an IPC `"shutdown"` message
  closes the server + db and prints one final sanitized-result JSON line
  (redacted `AcceptanceRequestRecord[]` + a redacted stub-invocation ledger:
  `{command, mode, pid}` only — no argv, prompt, CSRF, model, or profile).
- `scripts/tsconfig.ui-acceptance.json` — added the new entry to `include`.
- `scripts/ui-acceptance-fixture.ts` — `AccBuildPaths`/`compileAccBuild` now
  also expose `serverEntry` (the compiled `ui-acceptance-server.js` path);
  no behavioral change to the fixture builder itself.
- `tests/ui-acceptance-server.test.ts` (4 tests) — external-compile RED
  coverage (entry compiles to an outDir with zero repo/dist artifacts;
  compiled entry rejects a missing `--root` with exit 2 from an arbitrary
  cwd) plus two full compiled-process-group acceptance runs driving real
  HTTP: (1) manual-pass decide rejected inline on an empty note with the
  domain `decisions` table proven unwritten, then a valid decide + a
  high-risk review approve, both writing to the domain ledger, with the
  final result's `stubs` ledger empty (decide/review never touch the agent
  transport) and no secrets in the process's stdout; (2) all eight
  stub-backed transport submissions (4 auditors via `/api/audit-run`, 4
  clients via `/api/explain`) each producing exactly one local stub
  invocation and one request-ledger record, a missing-CSRF request that
  invokes no stub, request/stub ledger shape assertions (only the redacted
  fields, nothing else), and proof the TCP port is refused after SIGINT
  shutdown.
- `scripts/ui-acceptance.md` — new §5 documents the compiled server helper
  and its acceptance test; renumbered the old §5 (manual stub smoke) to §6.

## Decisions / tradeoffs

- **Mode inference for the injected `spawnAsync`**: `src/audit-runner.ts`
  passes different argv shapes for audit (`--json-schema`/`--output-schema`/
  `--mode json`) vs. explain (`textCommandFor`, no schema flag). The stub
  helper's wrapper scripts require an explicit `--mode {audit,explain}` flag
  the fixture-generated wrapper doesn't bake in (it only bakes `--transport`
  and `--stub-realpath`, forwarding `"$@"` verbatim). The injected
  `spawnAsync` derives `mode` from the real caller's own argv
  (`isAuditArgs`) and appends `['--mode', mode]` when invoking the wrapper —
  no product code changed, no wrapper-script changes.
- **Stub audit output is intentionally not schema-shaped**: `ui-agent-stub.ts`
  prints `{verdict, note}` for audit mode, not `{verdicts:[...]}` — its
  fixed output predates this task and is shared with the manual-smoke
  checklist. `runAuditAgentAsync`'s `normalize()` therefore rejects it
  (422), same as a real agent returning malformed output would. The
  acceptance test asserts exactly-one-stub-invocation and exactly-one-
  request-record per call, not a 200 status, matching the plan's actual
  acceptance criterion (transport reached, not verdict imported).
- **Two fresh fixture roots** are not needed in practice: `exportRequest`
  is based on latest-evidence-with-a-decided-verdict and is not filtered by
  prior audit history, so repeated `/api/audit-run` calls against one root
  return a stable item set and each auditor's verdict is a distinct
  `(evidenceId, auditor)` row — no domain conflict. One root is used for
  decide/review, a second for the eight transport submissions, purely to
  keep the two concerns' domain-ledger assertions independent and legible.

## Verification

- `node_modules/.bin/tsc --noEmit -p tsconfig.json` — 0 errors (product `src/`
  unaffected; not edited).
- `node_modules/.bin/tsc -p scripts/tsconfig.ui-acceptance.json --outDir <ext>`
  — 0 diagnostics; `scripts/ui-acceptance-server.js` compiles alongside the
  fixture/stub/browser-check/evidence-manifest entries.
- `./node_modules/.bin/vitest run tests/ui-acceptance-server.test.ts` — 4/4
  green.
- `./node_modules/.bin/vitest run tests/ui-acceptance-fixture.test.ts
  tests/ui-server.test.ts` — 12/12 and 26/26 green (no regression from the
  `AccBuildPaths`/`compileAccBuild` addition).
- `git status --porcelain` on the repo tree — only the five allowed files
  above; no `dist/scripts`, no `scripts/ui-acceptance-*.js` artifacts land
  in the repo tree.
