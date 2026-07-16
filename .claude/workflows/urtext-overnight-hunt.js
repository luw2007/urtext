/**
 * urtext-overnight-hunt.js — autonomous overnight bug-hunting loop for Urtext.
 *
 * Provenance: distilled from rue-language/rue `.claude/workflows/rue-overnight-hunt.js`
 * (2026-06 overnight runs). Every rule below exists because skipping it once caused
 * a real failure there. Re-write rules here as Urtext accumulates its own incidents.
 *
 * Runtime: agent-harness eval JS kernel. Primitives: agent(), parallel(), read(), write(), log().
 * Cheap models cast a wide net (find), strong models gatekeep (verify),
 * the main agent files issues. Structured JSON only — no prose findings.
 *
 * IRON LAW: NO REPRO, NO REPORT.
 * Every finding MUST carry a minimal repro that was actually written and actually
 * run, plus the exact observed behavior (stdout / exit code / stack trace).
 * Never confirm something you couldn't run.
 *
 * NOTE (pre-code phase): AREAS map to the modules named in docs/VISION.md §五.
 * Sweep only areas whose module has landed; the ledger tracks rotation.
 */

// ---------------------------------------------------------------------------
// AREAS — human-written attack-surface map. AI must not edit this block.
// Each area carries depth hints only the author knows, and known-bug exclusions
// ("don't re-report"). Keep hints current; a stale map wastes the whole night.
// ---------------------------------------------------------------------------
const AREAS = [
  {
    id: "clause-parser",
    name: "Clause parsing & anchor syntax",
    hints: [
      "Clauses live in markdown via HTML-comment anchors (VISION P6). Attack: duplicate clause ids across files, anchors split by markdown formatting, CRLF vs LF, unicode in ids, anchor inside code fences (must NOT parse), nested/overlapping anchors.",
      "A normative clause without an oracle binding is an ERROR, not a warning (P1). Verify the parser actually fails indexing, not silently skips.",
    ],
    knownBugs: [],
  },
  {
    id: "oracle-exec",
    name: "Oracle binding & execution (test/cmd/metric/diff-scope/manual)",
    hints: [
      "cmd oracles: exit-code interpretation, timeout handling (a hung oracle must not hang the run), non-zero-but-expected codes, stdout/stderr capture fidelity.",
      "metric oracles: threshold comparison edge cases (NaN, missing metric), non-determinism across runs.",
      "diff-scope oracles: path globs vs actual git diff paths; renames and mode-only changes.",
    ],
    knownBugs: [],
  },
  {
    id: "linker-graph",
    name: "Linker reference graph & stale propagation",
    hints: [
      "Cross-spec reference cycles must not livelock stale propagation. Dangling refs after clause deletion. Stale must propagate through design-artifact version bumps too (P7), not only text edits.",
      "Impact query must be mechanical: edit one clause, ask for affected clauses/checklists/code — answer must not require an LLM (VISION §三.3).",
    ],
    knownBugs: [],
  },
  {
    id: "evidence-store",
    name: "Evidence store & verdicts",
    hints: [
      "Content-addressed storage: same oracle output twice must dedupe; verdict must be immutable once recorded. Attack: evidence recorded against a stale clause revision, partial writes on crash, clock skew in ordering.",
    ],
    knownBugs: [],
  },
  {
    id: "unmapped-change",
    name: "Unmapped-change detection (fact-source enforcement, P3)",
    hints: [
      "The miscompile-equivalent for Urtext is a FALSE NEGATIVE here: a hand-edited hunk that maps to no clause yet passes undetected — spec corruption. Attack: whitespace-only hunks, file renames, hunks spanning two clauses' code regions, changes in generated files.",
      "provenance must be cross-checked against the real diff; an LLM-claimed clause→code mapping without diff confirmation must not land.",
    ],
    knownBugs: [],
  },
  {
    id: "dwarf-mapping",
    name: "DWARF layer: clause↔code↔evidence bidirectional mapping",
    hints: [
      "Both directions must stay consistent: clause→code and code→clause derived from the same store may drift if updated separately. Failure attribution must name a clause, never a stack frame (VISION §三.4).",
    ],
    knownBugs: [],
  },
  {
    id: "meta-verify",
    name: "Meta-verification & same-origin trap (P2)",
    hints: [
      "Attack the referee: construct an oracle that is green while the clause semantics are violated (test asserts nothing, cmd `exit 0` unconditionally, metric threshold trivially wide). Meta-verification must flag these; if it doesn't, that's a finding.",
    ],
    knownBugs: [],
  },
  {
    id: "risk-gating",
    name: "Risk gating & unsafe blocks (P4/P5)",
    hints: [
      "Attack: can a high-risk / unsafe-marked clause auto-pass without a human gate? Model-disagreement path must escalate, not average out. Irreversible-op detection bypass via indirection.",
    ],
    knownBugs: [],
  },
  {
    id: "cli-git",
    name: "CLI & git-native adoption path (P8)",
    hints: [
      "`cd existing repo` must just work: no git repo, dirty worktree, shallow clone, submodules, worktrees, non-UTF8 paths. Partial adoption: repo with 3 clauses and 100k lines of unmapped legacy code must not drown the user.",
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
const N_FINDERS = 4;

// --- coverage ledger: rotate to the least-recently-swept area -------------
const ledger = JSON.parse(read(LEDGER_PATH));
const area = AREAS
  .map((a) => ({ a, swept: ledger.swept[a.id] ?? "1970-01-01" }))
  .sort((x, y) => x.swept.localeCompare(y.swept))[0].a;
const runId = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const reproRoot = `/tmp/urtext-hunt/${runId}`;
log(`hunt run ${runId}: sweeping area '${area.id}'`);

// --- Phase 1: FIND — cheap models, wide net, over-capture ------------------
// Duplicates are fine; prefer plausible over silently dropped. But: never
// confirm something you couldn't run.
const finderPrompt = (angle, n) => `
You are bug-finder #${n} attacking the Urtext toolchain (repo: current directory).
Read docs/VISION.md first. Your area: "${area.name}".
Area hints from the author (trust these, they encode deep knowledge):
${area.hints.map((h) => `- ${h}`).join("\n")}
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

const found = await parallel(
  ANGLES.map((angle, i) => () =>
    agent(finderPrompt(angle, i + 1), { agent: "task", model: "smol", schema: FINDINGS_SCHEMA })
  )
);
const findings = found.flatMap((r) => r.findings ?? []);
log(`find phase: ${findings.length} raw findings`);

// --- Phase 2: VERIFY — strong model, re-run on current trunk ---------------
const verified = await parallel(
  findings.map((f) => () =>
    agent(
      `Independently verify this Urtext bug finding on the CURRENT trunk.
Do not trust the finder: re-run the repro yourself from ${f.repro_path}
(command: ${f.repro_command}), compare against expected="${f.expected}".
If the repro is missing or does not run, verdict=refuted.
Finding: ${JSON.stringify(f)}`,
      { agent: "task", schema: VERDICT_SCHEMA }
    ).then((v) => ({ ...f, ...v }))
  )
);

// --- Phase 3: FILE — dedupe against existing issues, then gh issue create --
const confirmed = verified.filter((v) => v.verdict !== "refuted");
log(`verify phase: ${confirmed.length}/${verified.length} survived`);
for (const f of confirmed) {
  // Dedupe first (Rue detour #2: AI output volume overwhelms naive tracking).
  await Bun.$`gh issue list --search ${f.title} --json number,title`.text().then(async (out) => {
    if (JSON.parse(out).length > 0) return log(`dup, skipping: ${f.title}`);
    const body = `Area: ${f.area}\nCategory: ${f.category}\nVerdict: ${f.verdict}\n\nRepro: \`${f.repro_command}\` (${f.repro_path})\nExpected: ${f.expected}\nObserved:\n\`\`\`\n${f.observed}\n\`\`\`\n\n_Filed by urtext-overnight-hunt ${runId}._`;
    await Bun.$`gh issue create --title ${`[hunt] ${f.title}`} --body ${body} --label hunt,${f.category}`;
  });
}

// --- update coverage ledger -------------------------------------------------
ledger.swept[area.id] = new Date().toISOString().slice(0, 10);
write(LEDGER_PATH, JSON.stringify(ledger, null, 2));
log(`hunt run ${runId} done: area '${area.id}' swept, ${confirmed.length} findings filed`);
