#!/usr/bin/env sh
# oracle-loops.sh — cmd oracles for specs/loops/spec.md, one named check per clause.
# The loop mechanism lives in prompt/protocol text; losing the text breaks the
# mechanism, so grep-presence is exactly the right verdict. Exit 0 = green.
# Usage: scripts/oracle-loops.sh <check-name>
set -eu
HUNT_CORE=.claude/workflows/lib/hunt-core.mjs
ADAPTERS=.claude/workflows/lib/adapters.mjs
FIX_CORE=.claude/workflows/lib/fix-core.mjs
AUDIT_CORE=.claude/workflows/lib/audit-core.mjs
SKILL=.claude/skills/integrate-worker/SKILL.md

case "${1:?usage: oracle-loops.sh <check-name>}" in
  trust-boundary)
    grep -q 'NEVER merge here' "$FIX_CORE" && grep -q '视为未验证' "$SKILL" ;;
  single-source)
    grep -q 'docs/VISION.md' "$HUNT_CORE" && grep -q 'docs/VISION.md' "$FIX_CORE" && grep -q 'docs/VISION.md' "$AUDIT_CORE" ;;
  shell-safety)
    grep -q 'SHELL SAFETY' "$HUNT_CORE" && grep -q 'SHELL SAFETY' "$FIX_CORE" ;;
  no-repro-no-report)
    grep -q 'NO REPRO, NO REPORT' "$HUNT_CORE" ;;
  rotation)
    grep -q 'ledger.swept' "$HUNT_CORE" && test -f .claude/workflows/hunt-ledger.json ;;
  model-split)
    grep -q 'model: "smol"' "$HUNT_CORE" ;;
  categories)
    grep -q 'false-verdict' "$HUNT_CORE" && grep -q 'style, performance, diagnostic wording' "$HUNT_CORE" ;;
  timeout)
    grep -q 'wrapped in a timeout' "$HUNT_CORE" ;;
  dedupe)
    grep -q 'gh issue list --search' "$ADAPTERS" ;;
  reproduce-first)
    grep -q 'REPRODUCE FIRST' "$FIX_CORE" && grep -q 'refutations are as valuable as fixes' "$FIX_CORE" ;;
  coverage-follows-capability)
    grep -q 'COVERAGE FOLLOWS CAPABILITY' "$FIX_CORE" ;;
  isolation)
    grep -q 'git worktree add' "$ADAPTERS" && grep -q 'MAX_WORKERS = 4' "$FIX_CORE" ;;
  no-scope-creep)
    grep -q 'NO SCOPE CREEP' "$FIX_CORE" ;;
  provenance-dogfood)
    grep -q 'UNMAPPED-CHANGE DOGFOOD' "$FIX_CORE" ;;
  four-lenses)
    grep -q 'drift:' "$AUDIT_CORE" && grep -q 'soundness:' "$AUDIT_CORE" && grep -q 'consistency:' "$AUDIT_CORE" && grep -q 'formal:' "$AUDIT_CORE" ;;
  read-only)
    grep -q 'Change NOTHING. File NO issues.' "$AUDIT_CORE" ;;
  run-required)
    grep -q 'exact command(s) actually executed' "$AUDIT_CORE" \
      && grep -q 'required: \["lens", "severity", "clause_ids", "title", "detail", "ran"\]' "$AUDIT_CORE" ;;
  seven-steps)
    grep -q '永远从新 trunk 开始' "$SKILL" && grep -q -- '--3way' "$SKILL" \
      && grep -q '亲手重验每个 repro' "$SKILL" && grep -q '跨机制测试' "$SKILL" \
      && grep -q '每行一个' "$SKILL" ;;
  lane-discipline)
    grep -q '车道纪律' "$SKILL" && grep -q '热点' "$SKILL" ;;
  unmapped-gate)
    grep -q 'manual-ack' "$SKILL" ;;
  areas-aligned)
    node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import { AREAS } from "./.claude/workflows/lib/hunt-core.mjs";

const landed = AREAS.filter((area) => area.landed === true);
if (landed.length !== 10) throw new Error(`expected 10 landed AREAS, got ${landed.length}`);

for (const area of landed) {
  if (!area.srcFile?.startsWith("src/") || !existsSync(area.srcFile)) {
    throw new Error(`${area.id}: missing srcFile ${area.srcFile}`);
  }
  const source = readFileSync(area.srcFile, "utf8");
  const exports = [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  const hints = area.hints.join("\n");
  if (!exports.some((name) => new RegExp(`\\b${name}\\b`).test(hints))) {
    throw new Error(`${area.id}: no exported symbol from ${area.srcFile} appears in hints`);
  }
}
NODE
    ;;
  *)
    echo "unknown check: $1" >&2; exit 2 ;;
esac
