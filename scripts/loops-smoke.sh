#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DRY_RUN=1 node --input-type=module <<'NODE'
import { makeStubRuntime } from "./.claude/workflows/lib/adapters.mjs";
import { run as runAudit } from "./.claude/workflows/lib/audit-core.mjs";
import { run as runFix } from "./.claude/workflows/lib/fix-core.mjs";
import { run as runHunt } from "./.claude/workflows/lib/hunt-core.mjs";

async function smoke(name, run, expectedWrite) {
  const runtime = makeStubRuntime();
  const writes = [];
  const write = runtime.write;
  runtime.write = async (path, content) => {
    writes.push(path);
    return write(path, content);
  };
  await run(runtime);
  if (!writes.some(expectedWrite)) throw new Error(`${name}: expected artifact was not written`);
  console.log(`DRY_RUN ${name} OK`);
}

await smoke("hunt", runHunt, (path) => path === ".claude/workflows/hunt-ledger.json");
await smoke("fix", runFix, (path) => path === "/tmp/urtext-fix/cycle-0/stub.meta");
await smoke("audit", runAudit, (path) => /^\/tmp\/urtext-audit-\d{4}-\d{2}-\d{2}\.json$/.test(path));
console.log("LOOPS SMOKE PASS");
NODE
