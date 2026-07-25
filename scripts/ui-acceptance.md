# S4 UI Acceptance Fixture — Manual Checklist (§8.2)

Executable checklist, not a substitute test. Run every command from the repo
root (`urtext-wt/ui-acceptance` or its final-verifier equivalent). `$ACC` and
`$FIXROOT` are scratch directories **outside** the repo tree — never inside
`dist/` or any package path.

## 1. External-outDir TypeScript check (P1 ACCEPTANCE-OUTDIR)

```sh
ACC=$(mktemp -d /tmp/urtext-acc-XXXXXX)
node_modules/.bin/tsc -p scripts/tsconfig.ui-acceptance.json --outDir "$ACC"
test -f "$ACC/scripts/ui-acceptance-fixture.js"
test -f "$ACC/scripts/ui-agent-stub.js"
```

Expect: exit 0, zero diagnostics, both compiled entries exist under `$ACC`.
`scripts/tsconfig.ui-acceptance.json` has no `outDir` key — an invocation
without `--outDir` would emit next to the sources, so `--outDir` must always
be passed explicitly.

## 2. Repo and `dist/` stay untouched

```sh
git status --porcelain            # must print nothing
test ! -e dist/scripts            # acceptance build never lands under dist/
test ! -e scripts/ui-acceptance-fixture.js
test ! -e scripts/ui-agent-stub.js
```

## 3. Fixture build / cleanup roundtrip (compiled entry)

```sh
mkdir -p "$ACC/package.json" 2>/dev/null; true   # (step 1 already wrote it)
FIXROOT=$(mktemp -d /tmp/urtext-fixture-XXXXXX)/fixture
node "$ACC/scripts/ui-acceptance-fixture.js" --root "$FIXROOT" > /tmp/urtext-fixture.json
cat /tmp/urtext-fixture.json
# {"root":..., "targets":{"manual":"specs/demo/spec.md#C003", ...},
#  "mappingBaselineSha":..., "implementationSha":...}
test -d "$FIXROOT/.git"
test -f "$FIXROOT/.urtext/registry.sqlite"
git -C "$FIXROOT" status --porcelain   # clean worktree
```

Run it a second time against a fresh root and diff the two JSON payloads'
`targets`, `mappingBaselineSha`, and `implementationSha` — they must be
byte-identical (deterministic commit dates); only `root` differs.

```sh
node "$ACC/scripts/ui-acceptance-fixture.js" --cleanup "$FIXROOT"
test ! -e "$FIXROOT"
```

Cleanup must also be safe to call on an already-removed root (interrupted
runs): re-run the same `--cleanup "$FIXROOT"` command and confirm it still
exits 0 with `{"ok":true,...}` and the root remains absent.

## 4. Targeted Vitest

```sh
./node_modules/.bin/vitest run tests/ui-acceptance-fixture.test.ts
```

Expect: 10/10 green, covering arbitrary-cwd setup, cleanup idempotency,
cross-root repeatability, the five real C004 mapping diffs, the
dependent/manual targets, the `unmapped.txt` dirty/clean roundtrip, the
external-outDir compile, and all eight stub-wrapper modes plus the delayed
mode.

## 5. Compiled internal server helper — real HTTP, local stub transport

```sh
./node_modules/.bin/vitest run tests/ui-acceptance-server.test.ts
```

Expect: 5/5 green. `scripts/ui-acceptance-server.ts` deep-imports
`startUiServerWithDeps` (never the public `startUiServer`) and is compiled by
the same `scripts/tsconfig.ui-acceptance.json` external-outDir build as the
fixture and stub entries. Run as `node <ACC>/scripts/ui-acceptance-server.js
--root <fixture-root>` from any cwd, it opens the fixture's own registry,
builds a local `.urtext/ui-agent-stubs/` wrapper bundle, and starts the
internal server on port 0 with an injected `spawnAsync` that only ever routes
to those local wrappers — never a real agent CLI or the network. It prints
one readiness JSON line (`{"schema":"urtext.ui-acceptance-server.ready/1","url":...}`)
once listening, and on `SIGINT` (or an IPC `"shutdown"` message) closes the
server and db, releases the port, and prints one final sanitized-result JSON
line (`{"schema":"urtext.ui-acceptance-server.result/1","requests":[...],"stubs":[...]}`)
before exiting 0. Both ledgers are redacted shape-only records — no raw
argv, prompt, CSRF token, model, or profile ever appears in either.

The test drives real HTTP against the compiled, running instance: console
GET + CSRF token, a manual-pass decide rejected inline on an empty note (with
the domain `decisions` table proven unwritten), a valid decide, a high-risk
review approve, a missing-CSRF 403 that reaches no stub, and all eight
stub-backed transport submissions (4 auditors × `/api/audit-run`, 4 clients ×
`/api/explain`) — each yielding exactly one local stub invocation and one
redacted request record. The domain ledger (SQLite `decisions`/`reviews`/
`audit_verdicts` tables), the request ledger, and the stub-invocation ledger
are asserted as three structurally distinct records.

The server is started with `pageSize: 2` (the fixture ships 5 live clauses
across one spec), so a further assertion drives real HTTP at `/agent`,
`/specs`, `/specs?page=2`, and `/decisions`: all four return `200` with an
`<html` body, `/specs` renders `第 1/3 页` at the default page and `第 2/3 页`
at `?page=2` (proving the pagination wiring itself, not just route
presence), and the final request ledger carries `pathClass` values `agent`,
`specs`, and `decisions` in the same six-key redacted shape as every other
record.

## 6. Manual agent-stub smoke (spot check, four wrappers × two modes)

```sh
FIXROOT=$(mktemp -d /tmp/urtext-fixture-XXXXXX)/fixture
node "$ACC/scripts/ui-acceptance-fixture.js" --root "$FIXROOT" > /tmp/urtext-fixture.json
BIN="$FIXROOT/.urtext/ui-agent-stubs/bin"
LOG="$FIXROOT/.urtext/ui-agent-stubs/invocations.log"
HOME="$FIXROOT/.urtext/ui-agent-stubs/home" URTEXT_STUB_LOG="$LOG" "$BIN/claude" --mode audit
HOME="$FIXROOT/.urtext/ui-agent-stubs/home" URTEXT_STUB_LOG="$LOG" "$BIN/codex" --mode explain
cat "$LOG"    # one redacted JSON line per call — never raw argv/prompt bytes
stat -f '%Lp' "$BIN/claude"   # 0700 on every wrapper (macOS `stat -f`; use -c on Linux)
```

Delayed mode:

```sh
URTEXT_STUB_DELAY_MS=750 HOME="$FIXROOT/.urtext/ui-agent-stubs/home" URTEXT_STUB_LOG="$LOG" \
  time "$BIN/traecli" --mode audit
```

Expect: wall time ≥ ~750ms, and the log's last line has `"delayedMs":750`.

```sh
node "$ACC/scripts/ui-acceptance-fixture.js" --cleanup "$FIXROOT"
rm -rf "$ACC"
```

## 7. Real browser matrix — reference invocation (not executed/verified here)

This checklist's own scope stops at the fixture/stub/compiled-server triad
above; it never spawns a real browser. The full console-family + brief/error
matrix (`docs/plans/urtext-20260725-console-pagination.md` §10) is driven
separately, against a running compiled server (`$SERVER_URL` = the `url`
from step 5's readiness line), with seven `--page name=url` arguments — one
per page name in the browser/contrast matrix:

```sh
node scripts/ui-browser-check-wrapper.mjs \
  --chrome <path-to-chrome> \
  --check "$ACC/scripts/ui-browser-check.js" \
  --contrast-manifest tests/ui-contrast-manifest.json \
  --source-root . \
  --page console="$SERVER_URL/" \
  --page agent="$SERVER_URL/agent" \
  --page specs="$SERVER_URL/specs" \
  --page specs-page-2="$SERVER_URL/specs?page=2" \
  --page decisions="$SERVER_URL/decisions" \
  --page brief="$SERVER_URL/brief?spec=specs%2Fdemo%2Fspec.md&clause=C004" \
  --page error="$SERVER_URL/brief?spec=specs%2Fdemo%2Fspec.md&clause=C999" \
  --disclosure blame-diff=true
```

`specs-page-2` is its own page name because the server's `pageSize: 2` (step
5) turns the fixture's 5 live clauses into exactly 3 `/specs` pages.
`--disclosure` carries only `blame-diff` (brief's collapsible diff block,
open for the high-risk C004 clause) — there is no `agent-lane` entry: Agent
lane is no longer a collapsible `<details>` inside `/`, it is its own
always-rendered `/agent` page, so it has no open/closed state to assert.

This is reference material for whoever runs the trusted final Chrome/CDP
gate; it is not run, and its output is not part of, this checklist's own
sign-off below.

## Sign-off

Steps 1–6 above must all pass with the exact commands shown — no
substituted script, no skipped step. A failure in any of them blocks S4; do
not report the fixture as ready. Step 7 is reference material for the
separate trusted final Chrome gate and is not executed as part of this
sign-off.
