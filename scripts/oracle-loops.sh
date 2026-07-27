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

# Print each verified assertion: evidence must carry what was checked, not a
# silent exit code — meta-audit reads the output, not this script.
check() {
  pattern=$1
  file=$2
  grep -Fq -- "$pattern" "$file"
  echo "verified: '$pattern' present in $file"
}
check_file() {
  file=$1
  test -f "$file"
  echo "verified: '$file' exists"
}

case "${1:?usage: oracle-loops.sh <check-name>}" in
  trust-boundary)
    grep -q 'NEVER merge here' "$FIX_CORE" && grep -q '视为未验证' "$SKILL" ;;
  single-source)
    check 'Read docs/VISION.md first. Your area:' "$HUNT_CORE"
    check 'Read docs/VISION.md before anything.' "$FIX_CORE"
    check 'Read docs/VISION.md first.' "$AUDIT_CORE" ;;
  shell-safety)
    check 'never compose rm/mv/redirect targets from shell variables' "$HUNT_CORE"
    check 'literal /tmp paths' "$HUNT_CORE"
    check 'null-guards' "$HUNT_CORE"
    check 'prefer leaving temp files over deleting them' "$HUNT_CORE"
    check 'never rm' "$HUNT_CORE"
    check 'inside the repo checkout' "$HUNT_CORE"
    check 'compose rm/mv/redirect targets from shell variables' "$FIX_CORE"
    check 'literal /tmp paths' "$FIX_CORE"
    check 'null-guard with' "$FIX_CORE"
    check "don't delete temp files at all" "$FIX_CORE"
    check 'NEVER rm inside the repo checkout' "$FIX_CORE" ;;
  no-repro-no-report)
    check '1. Write a minimal repro under ${reproRoot}/finding-${n}-<seq>/ (unique dirs; other finders run in parallel — never write outside your numbered dirs).' "$HUNT_CORE"
    check '2. Actually run it, wrapped in a timeout (inputs may hang the tool).' "$HUNT_CORE"
    check '3. Record the exact observed behavior: stdout, exit code, stack trace text.' "$HUNT_CORE" ;;
  rotation)
    check '.sort((x, y) => x.swept.localeCompare(y.swept))' "$HUNT_CORE"
    check 'ledger.swept[area.id] = new Date().toISOString().slice(0, 10);' "$HUNT_CORE"
    check_file .claude/workflows/hunt-ledger.json ;;
  model-split)
    check 'model: "smol"' "$HUNT_CORE"
    check 'boundary inputs: empty, huge, unicode, malformed, truncated mid-token' "$HUNT_CORE"
    check 'adversarial construction: inputs designed to make the referee lie' "$HUNT_CORE"
    check 'state & ordering: crash mid-write, re-run idempotency, stale caches, concurrent invocations' "$HUNT_CORE"
    check 'integration seams: git interop, filesystem edge cases, CLI flag combinations' "$HUNT_CORE"
    check 'Independently verify this Urtext bug finding on the CURRENT trunk' "$HUNT_CORE" ;;
  categories)
    check '"false-verdict",' "$HUNT_CORE"
    check '"missed-unmapped",' "$HUNT_CORE"
    check '"crash",' "$HUNT_CORE"
    check '"reject-valid",' "$HUNT_CORE"
    check '"accept-invalid",' "$HUNT_CORE"
    check 'style, performance, diagnostic wording' "$HUNT_CORE" ;;
  timeout)
    grep -q 'wrapped in a timeout' "$HUNT_CORE" ;;
  dedupe)
    grep -q 'gh issue list --search' "$ADAPTERS" ;;
  reproduce-first)
    check '1. REPRODUCE FIRST. Before changing any code, reproduce every claimed bug in' "$FIX_CORE"
    check 'YOUR checkout. If you cannot reproduce it, report it as refuted in your meta —' "$FIX_CORE"
    check 'refutations are as valuable as fixes.' "$FIX_CORE"
    check 'bug gets a regression PIN test (a test that pins the current correct' "$FIX_CORE"
    check 'behavior), not a fix.' "$FIX_CORE" ;;
  coverage-follows-capability)
    check 'COVERAGE FOLLOWS CAPABILITY' "$FIX_CORE"
    check 'MUST gain tests in the same change' "$FIX_CORE" ;;
  isolation)
    check 'git worktree add' "$ADAPTERS"
    check 'const MAX_WORKERS = 4;' "$FIX_CORE"
    check 'if (clusters.length > MAX_WORKERS) throw' "$FIX_CORE"
    check '2. Emit your diff: git -C ${outDir}/wt-${cluster.key} diff > ${outDir}/${cluster.key}.diff' "$FIX_CORE"
    check '3. Return your meta summary as structured JSON.' "$FIX_CORE"
    check 'your output is a diff file, not a merge.' "$FIX_CORE" ;;
  no-scope-creep)
    check 'Fix ONLY the issues listed in your cluster.' "$FIX_CORE"
    check 'update the comment in the same change (comments are source' "$FIX_CORE"
    check 'Unrelated improvements go in meta.followups, not in the diff.' "$FIX_CORE" ;;
  provenance-dogfood)
    check 'If specs with clauses exist for the module you touch, note in meta which' "$FIX_CORE"
    check 'clause ids your hunks map to; hunks you cannot attribute must be listed under' "$FIX_CORE"
    check 'meta.unmapped with a one-line justification.' "$FIX_CORE" ;;
  four-lenses)
    grep -q 'drift:' "$AUDIT_CORE" && grep -q 'soundness:' "$AUDIT_CORE" && grep -q 'consistency:' "$AUDIT_CORE" && grep -q 'formal:' "$AUDIT_CORE" ;;
  read-only)
    grep -q 'Change NOTHING. File NO issues.' "$AUDIT_CORE" ;;
  run-required)
    grep -q 'exact command(s) actually executed' "$AUDIT_CORE" \
      && grep -q 'required: \["lens", "severity", "clause_ids", "title", "detail", "ran"\]' "$AUDIT_CORE" ;;
  seven-steps)
    check '### 1. 永远从新 trunk 开始' "$SKILL"
    check '### 2. 3-way 应用 diff' "$SKILL"
    check '### 3. 亲手重验每个 repro' "$SKILL"
    check '### 4. 写跨机制测试' "$SKILL"
    check '### 5. 全套测试 + 格式化' "$SKILL"
    check '项目全量测试命令 exit 0，格式化通过，才进入下一步。' "$SKILL"
    check '### 6. 提交 / 发 PR' "$SKILL"
    check '### 7. 处理弹回' "$SKILL"
    check '兄弟 PR 先合入导致本 PR DIRTY 时：rebase 到新 trunk，解决冲突时**保住两个 PR 的语义**，' "$SKILL"
    check '重跑自己和兄弟的 repro，再全套测试。' "$SKILL" ;;
  lane-discipline)
    check '并行 worker 只能跨**不相交的模块集合**，永不共享热点文件。' "$SKILL"
    check '热点文件必须串行（合一个再派下一个）。' "$SKILL"
    check '当前热点清单（人工维护' "$SKILL"
    check '| 热点 | 原因 |' "$SKILL"
    check '| linker 的 clause 注册表 | 所有 clause 注册路径汇聚点 |' "$SKILL" ;;
  unmapped-gate)
    check '逐条裁决：回写 spec 或显式 manual-ack' "$SKILL"
    check 'unmapped 非空且未裁决的 diff 不得合入' "$SKILL" ;;
  referee-run)
    grep -q "Never confirm something you couldn't run" "$HUNT_CORE" \
      && grep -q 'FULL VERIFICATION GATE' "$FIX_CORE" \
      && grep -q 'No run, no behavioral finding' "$AUDIT_CORE" ;;
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
