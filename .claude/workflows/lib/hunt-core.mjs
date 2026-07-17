/**
 * urtext overnight hunt core.
 *
 * IRON LAW: NO REPRO, NO REPORT.
 * Every finding MUST carry a minimal repro that was actually written and actually
 * run, plus the exact observed behavior (stdout / exit code / stack trace).
 * Never confirm something you couldn't run.
 *
 * NOTE: AREAS map to the modules named in docs/VISION.md §五.
 * Sweep only areas whose module has landed; the ledger tracks rotation.
 */

// ---------------------------------------------------------------------------
// AREAS — human-written attack-surface map. AI must not edit this block.
// Each area carries depth hints only the author knows, and known-bug exclusions
// ("don't re-report"). Keep hints current; a stale map wastes the whole night.
// ---------------------------------------------------------------------------
export const AREAS = [
  {
    id: "clause-parser",
    landed: true,
    name: "Clause parsing & anchor syntax",
    srcFile: "src/clause-parser.ts",
    hints: [
      "Clauses live in markdown via HTML-comment anchors (VISION P6). Attack: duplicate clause ids across files, anchors split by markdown formatting, CRLF vs LF, unicode in ids, anchor inside code fences (must NOT parse), nested/overlapping anchors. 符号锚: src/clause-parser.ts 导出 parseClauseFile / ORACLE_KINDS / ParsedClause。",
      "A normative clause without an oracle binding is an ERROR, not a warning (P1). Verify the parser actually fails indexing, not silently skips. 符号锚: parseClauseFile 的 ClauseParseError 路径。",
    ],
    knownBugs: [],
  },
  {
    id: "oracle-exec",
    landed: true,
    name: "Oracle binding & execution (test/cmd/metric/diff-scope/manual)",
    srcFile: "src/oracle-runner.ts",
    hints: [
      "cmd oracles: exit-code interpretation, timeout handling (a hung oracle must not hang the run), non-zero-but-expected codes, stdout/stderr capture fidelity. 符号锚: src/oracle-runner.ts 导出 runOracle / OracleResult / Verdict。",
      "metric oracles: threshold comparison edge cases (NaN, missing metric), non-determinism across runs. diff-scope oracles: path globs vs actual git diff paths; renames and mode-only changes.",
    ],
    knownBugs: [],
  },
  {
    id: "linker",
    landed: true,
    name: "Linker reference graph & stale propagation",
    srcFile: "src/linker.ts",
    hints: [
      "Cross-spec reference cycles must not livelock stale propagation. Dangling refs after clause deletion. Stale must propagate through design-artifact version bumps too (P7), not only text edits. 符号锚: src/linker.ts 导出 linkWorkspace / propagateStale / impact。",
      "Impact query must be mechanical: edit one clause, ask for affected clauses/checklists/code — answer must not require an LLM (VISION §三.3). 符号锚: impact(db, source) 返回 ImpactReport。",
    ],
    knownBugs: [],
  },
  {
    id: "dwarf",
    landed: true,
    name: "DWARF layer: clause↔code↔evidence bidirectional mapping + unmapped-change detection (P3)",
    srcFile: "src/dwarf.ts",
    hints: [
      "Both directions must stay consistent: clause→code and code→clause derived from the same store may drift if updated separately. Failure attribution must name a clause, never a stack frame (VISION §三.4). 符号锚: src/dwarf.ts 导出 recordMapping / blame / recordAck。",
      "The miscompile-equivalent for Urtext is a FALSE NEGATIVE in unmapped detection: a hand-edited hunk that maps to no clause yet passes undetected — spec corruption. Attack: whitespace-only hunks, file renames, hunks spanning two clauses' code regions, changes in generated files. provenance must be cross-checked against the real diff. 符号锚: detectUnmapped / diffHunks / UnmappedReport。",
    ],
    knownBugs: [],
  },
  {
    id: "risk-gate",
    landed: true,
    name: "Risk gating & unsafe blocks (P4/P5)",
    srcFile: "src/gate.ts",
    hints: [
      "Attack: can a high-risk / unsafe-marked clause auto-pass without a human gate? Model-disagreement path must escalate, not average out. Irreversible-op detection bypass via indirection. 符号锚: src/gate.ts 导出 adjudicate / GateReport / Decision('auto-pass'|'human')。",
      "adjudicate must count unmapped changes into the human-gate decision; a high unmappedCount must not silently auto-pass.",
    ],
    knownBugs: [],
  },
  {
    id: "meta-review",
    landed: true,
    name: "Human review ledger at head (approve/reject provenance)",
    srcFile: "src/review.ts",
    hints: [
      "Review verdicts are recorded against a specific head sha and must be immutable once written. Attack: review recorded against a stale head, approve/reject race at same head, reviewsAtHead returning verdicts from a different revision. 符号锚: src/review.ts 导出 recordReview / reviewsAtHead / currentHead / ReviewOutcome。",
      "Same-origin trap (P2): the referee that records review must not be the same authority that produced the artifact under review; a review that trivially approves everything is a finding.",
    ],
    knownBugs: [],
  },
  {
    id: "decision-log",
    landed: true,
    name: "Decision ledger for manual-clause adjudication (M6)",
    srcFile: "src/decision.ts",
    hints: [
      "Manual clauses (oracle:manual) get a human pass/fail decision recorded per head. Attack: decision recorded against stale head, decisionsAtHead mixing revisions, a fail decision silently dropped so verify reads pass. 符号锚: src/decision.ts 导出 recordDecision / decisionsAtHead / listDecisions / DecisionVerdict。",
      "listDecisions must be append-only and immutable; a rewritten historical decision is spec-history corruption.",
    ],
    knownBugs: [],
  },
  {
    id: "spec-audit",
    landed: true,
    name: "Sprint audit: export/import verdicts & coverage of the referee stack",
    srcFile: "src/audit.ts",
    hints: [
      "Audit exports the current oracle/evidence surface for external review then imports verdicts back. Attack: importVerdicts accepting verdicts for clauses not in the export request, coverage() under-counting manual share, a partial import leaving the ledger half-written. 符号锚: src/audit.ts 导出 exportRequest / importVerdicts / coverage / CoverageReport。",
      "coverage manual-share (VISION P9) must be computed from real evidence rows, not assumed; an inflated cmd-share hides referee rot.",
    ],
    knownBugs: [],
  },
  {
    id: "registry",
    landed: true,
    name: "Registry: index clause/task files & cross-ref integrity",
    srcFile: "src/registry.ts",
    hints: [
      "Indexing must be fail-closed: any parse/cross-ref error keeps the revision at 'building', never partially indexed. Attack: dangling cross-refs to deleted clauses, duplicate ids across files, tombstoned file resurrection, task→clause ref to a nonexistent clause. 符号锚: src/registry.ts 导出 indexClauseFile / indexTaskFile / tombstoneFile / openRegistry / CrossRefError。",
      "A ready revision must be atomic: openRegistry + index must not leave a workspace queryable at a half-applied state.",
    ],
    knownBugs: [],
  },
  {
    id: "cli-scan",
    landed: true,
    name: "CLI & git-native adoption path: workspace scan / unit discovery (P8)",
    srcFile: "src/scanner.ts",
    hints: [
      "`cd existing repo` must just work: no git repo, dirty worktree, shallow clone, submodules, worktrees, non-UTF8 paths. Partial adoption: repo with 3 clauses and 100k lines of unmapped legacy code must not drown the user. 符号锚: src/scanner.ts 导出 discoverUnits / scanWorkspace / FeatureUnit / ScanReport。",
      "discoverUnits must be deterministic across runs and must not silently skip a feature dir on a transient fs error (fail-closed, not fail-empty).",
    ],
    knownBugs: [],
  },
];

const CATEGORIES = [
  "false-verdict",   // oracle green while clause violated  (miscompile-equivalent)
  "missed-unmapped", // unmapped change not detected        (unsoundness-equivalent)
  "crash",           // toolchain crash / unhandled throw   (ICE-equivalent)
  "reject-valid",    // valid spec/anchor/oracle rejected
  "accept-invalid",  // invalid clause indexed (e.g. normative w/o oracle)
];
// Explicitly OUT of scope: style, performance, diagnostic wording.

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "area", "category", "title", "repro_path", "repro_command", "expected", "observed", "confidence"],
        properties: {
          id: { type: "string", description: "unique per run, e.g. F-<runId>-<finder>-<n>" },
          area: { type: "string" },
          category: { enum: CATEGORIES },
          title: { type: "string" },
          repro_path: { type: "string", description: "path to the minimal repro actually written" },
          repro_command: { type: "string", description: "exact command actually run (timeout-wrapped)" },
          expected: { type: "string" },
          observed: { type: "string", description: "exact stdout/exit code/stack actually observed" },
          confidence: { enum: ["confirmed", "plausible"] },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "observed"],
  properties: {
    verdict: { enum: ["confirmed", "plausible", "refuted"] },
    observed: { type: "string" },
    notes: { type: "string" },
  },
};

// Four finder angles — mutually exclusive lenses on the SAME area.
const ANGLES = [
  "boundary inputs: empty, huge, unicode, malformed, truncated mid-token",
  "adversarial construction: inputs designed to make the referee lie (green while wrong)",
  "state & ordering: crash mid-write, re-run idempotency, stale caches, concurrent invocations",
  "integration seams: git interop, filesystem edge cases, CLI flag combinations",
];

const LEDGER_PATH = ".claude/workflows/hunt-ledger.json";

function hasAreaLabel(issue, areaId) {
  return (issue.labels ?? []).some((label) =>
    (typeof label === "string" ? label : label.name) === `area:${areaId}`
  );
}

export async function run(runtime) {
  const ledger = JSON.parse(await runtime.read(LEDGER_PATH));
  const areaDefinition = AREAS
    .filter((candidate) => candidate.landed === true)
    .map((candidate) => ({ candidate, swept: ledger.swept[candidate.id] ?? "1970-01-01" }))
    .sort((x, y) => x.swept.localeCompare(y.swept))[0].candidate;

  // gh→area rule: only open hunt issues carrying area:<id> enter that area's knownBugs.
  // Issues without an area label never leak into an unrelated sweep.
  const openIssues = await runtime.adapters.gh.list([
    "issue", "list", "--label", "hunt", "--state", "open", "--json", "number,title,labels",
  ]);
  const area = {
    ...areaDefinition,
    knownBugs: openIssues.filter((issue) => hasAreaLabel(issue, areaDefinition.id)).map((issue) => issue.title),
  };
  const runId = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const reproRoot = `/tmp/urtext-hunt/${runId}`;
  runtime.log(`hunt run ${runId}: sweeping area '${area.id}'`);

  const finderPrompt = (angle, n) => `
You are bug-finder #${n} attacking the Urtext toolchain (repo: current directory).
Read docs/VISION.md first. Your area: "${area.name}".
Area hints from the author (trust these, they encode deep knowledge):
${area.hints.map((hint) => `- ${hint}`).join("\n")}
Known bugs — do NOT re-report: ${area.knownBugs.join(", ") || "(none)"}
Your exclusive angle: ${angle}

IRON LAW: NO REPRO, NO REPORT. For every finding you MUST:
1. Write a minimal repro under ${reproRoot}/finding-${n}-<seq>/ (unique dirs; other finders run in parallel — never write outside your numbered dirs).
2. Actually run it, wrapped in a timeout (inputs may hang the tool).
3. Record the exact observed behavior: stdout, exit code, stack trace text.
SHELL SAFETY (unattended run — one flagged command stalls the whole night, Rue detour #7):
never compose rm/mv/redirect targets from shell variables; use literal /tmp paths
or \${VAR:?} null-guards; prefer leaving temp files over deleting them; never rm
inside the repo checkout.
Categories (anything else is out of scope, including style/perf/diagnostic wording):
${CATEGORIES.join(", ")}.
Over-capture is fine; duplicates are fine; mark 'plausible' rather than dropping —
but NEVER mark 'confirmed' for anything you did not run yourself.
Return findings as structured JSON per the schema. If the module for this area
does not exist yet, return an empty findings list — do not invent findings.`;

  const found = await runtime.parallel(
    ANGLES.map((angle, index) => () =>
      runtime.adapters.agent(finderPrompt(angle, index + 1), {
        agent: "task",
        model: "smol",
        schema: FINDINGS_SCHEMA,
      })
    )
  );
  const findings = found.flatMap((result) => result.findings ?? []);
  runtime.log(`find phase: ${findings.length} raw findings`);

  const verified = await runtime.parallel(
    findings.map((finding) => () =>
      runtime.adapters.agent(
        `Independently verify this Urtext bug finding on the CURRENT trunk.
Do not trust the finder: re-run the repro yourself from ${finding.repro_path}
(command: ${finding.repro_command}), compare against expected="${finding.expected}".
If the repro is missing or does not run, verdict=refuted.
Finding: ${JSON.stringify(finding)}`,
        { agent: "task", schema: VERDICT_SCHEMA }
      ).then((verdict) => ({ ...finding, ...verdict }))
    )
  );

  const confirmed = verified.filter((verdict) => verdict.verdict !== "refuted");
  runtime.log(`verify phase: ${confirmed.length}/${verified.length} survived`);
  for (const finding of confirmed) {
    const duplicates = await runtime.adapters.gh.list([
      "issue", "list", "--search", finding.title, "--json", "number,title",
    ]);
    if (duplicates.length > 0) {
      runtime.log(`dup, skipping: ${finding.title}`);
      continue;
    }
    const body = `Area: ${finding.area}\nCategory: ${finding.category}\nVerdict: ${finding.verdict}\n\nRepro: \`${finding.repro_command}\` (${finding.repro_path})\nExpected: ${finding.expected}\nObserved:\n\`\`\`\n${finding.observed}\n\`\`\`\n\n_Filed by urtext-overnight-hunt ${runId}._`;
    await runtime.adapters.gh.create([
      "issue", "create",
      "--title", `[hunt] ${finding.title}`,
      "--body", body,
      "--label", `hunt,${finding.category}`,
      "--label", `area:${finding.area}`,
    ]);
  }

  ledger.swept[area.id] = new Date().toISOString().slice(0, 10);
  await runtime.write(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  runtime.log(`hunt run ${runId} done: area '${area.id}' swept, ${confirmed.length} findings filed`);
}
