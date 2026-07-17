/**
 * urtext-fix-cycle.js — N-worker parallel bug-fixing loop for Urtext.
 *
 * Provenance: distilled from rue-language/rue `.claude/workflows/rue-fix-cycle.js`,
 * whose PREAMBLE was itself "distilled from cycles 8-15 of the 2026-06 runs".
 * Every rule cites the incident that created it. Add Urtext's own incidents here.
 *
 * Invocation contract: caller passes { cycle: N, clusters: [{ key, prompt, issues: [n...] }] }.
 * One worker per cluster, each in an ISOLATED git worktree, max 4 in parallel.
 * Output per worker: <out>/<key>.diff + <out>/<key>.meta (JSON summary).
 *
 * TRUST BOUNDARY: nothing a worker claims is verified. Diffs go through
 * .claude/skills/integrate-worker/SKILL.md before touching trunk. NEVER merge here.
 *
 * LANE DISCIPLINE (caller's job): clusters must touch disjoint module sets.
 * Hot files must be serialized (one worker lands before the next is dispatched).
 * Hot-file list lives in the integrate-worker skill; keep it current.
 */

const MAX_WORKERS = 4;

// ---------------------------------------------------------------------------
// PREAMBLE — prepended to every worker prompt. Rules are load-bearing; each
// traces to a real incident (Rue's, until Urtext earns its own).
// ---------------------------------------------------------------------------
const PREAMBLE = `
You are a fix worker on the Urtext toolchain. Read docs/VISION.md before anything.
You work in an ISOLATED git worktree; your output is a diff file, not a merge.
Your claims will be treated as UNVERIFIED by the integrator — earn trust with evidence.

1. REPRODUCE FIRST. Before changing any code, reproduce every claimed bug in
   YOUR checkout. If you cannot reproduce it, report it as refuted in your meta —
   refutations are as valuable as fixes. Honesty over completeness. A refuted
   bug gets a regression PIN test (a test that pins the current correct
   behavior), not a fix.

2. COVERAGE FOLLOWS CAPABILITY. Any new oracle type, clause syntax, linker edge,
   or detection path MUST gain tests in the same change, covering the new
   surface with multiple cases. (Incident: Rue RUE-311 — a coverage gap let heap
   corruption merge green. Urtext equivalent: a detection gap lets spec
   corruption land silently.)

3. FULL VERIFICATION GATE. Run sh scripts/full-test.sh and require exit 0 before
   you emit your diff. If no test harness exists yet for the module you touched,
   say so explicitly in meta.blockers — do not fake a pass.

4. SHELL SAFETY. A flagged command stalls the whole overnight run waiting for a
   sleeping human (Rue detour #7). Therefore:
   - NEVER compose rm/mv/redirect targets from shell variables ('rm $DIR/$f.out' gets flagged).
   - Use literal /tmp paths, or null-guard with \${VAR:?}.
   - Best: don't delete temp files at all — overwrite or leave them.
   - NEVER rm inside the repo checkout.

5. NO SCOPE CREEP. Fix ONLY the issues listed in your cluster. If a change makes
   a comment stale, update the comment in the same change (comments are source
   of truth). Unrelated improvements go in meta.followups, not in the diff.

6. UNMAPPED-CHANGE DOGFOOD. Urtext enforces clause↔code provenance (VISION P3).
   If specs with clauses exist for the module you touch, note in meta which
   clause ids your hunks map to; hunks you cannot attribute must be listed under
   meta.unmapped with a one-line justification.
`;

const META_SCHEMA = {
  type: "object",
  required: ["key", "fixed", "refuted", "tests_added", "full_suite_green"],
  properties: {
    key: { type: "string" },
    fixed: { type: "array", items: { type: "number" }, description: "issue numbers actually fixed (repro re-run: now passing)" },
    refuted: {
      type: "array",
      items: {
        type: "object",
        required: ["issue", "reason", "pin_test"],
        properties: { issue: { type: "number" }, reason: { type: "string" }, pin_test: { type: "string" } },
      },
    },
    tests_added: { type: "array", items: { type: "string" } },
    full_suite_green: { type: "boolean" },
    clause_map: { type: "object", description: "hunk→clause-id attribution", additionalProperties: { type: "string" } },
    unmapped: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    followups: { type: "array", items: { type: "string" } },
  },
};

// --- read invocation --------------------------------------------------------
const { cycle, clusters } = JSON.parse(read(".claude/workflows/fix-cycle-input.json"));
if (!Array.isArray(clusters) || clusters.length === 0) throw new Error("no clusters");
if (clusters.length > MAX_WORKERS) throw new Error(`max ${MAX_WORKERS} parallel workers; serialize the rest`);
const outDir = `/tmp/urtext-fix/cycle-${cycle}`;
log(`fix cycle ${cycle}: ${clusters.length} workers -> ${outDir}`);

// --- set up isolated worktrees (artifact isolation: never share a tree) -----
const base = (await Bun.$`git rev-parse HEAD`.text()).trim();
for (const c of clusters) {
  await Bun.$`git worktree add ${`${outDir}/wt-${c.key}`} ${base}`;
}

// --- dispatch workers --------------------------------------------------------
// Model routing (human policy): workers get the default strong model. The
// strongest model is reserved for integration judgment in the main loop —
// grant it to a cluster only when its prompt explicitly demands it.
const results = await parallel(
  clusters.map((c) => () =>
    agent(
      `${PREAMBLE}
Your worktree: ${outDir}/wt-${c.key} (work ONLY there).
Your cluster key: ${c.key}. Issues: ${JSON.stringify(c.issues)}.
Fetch each issue body with: gh issue view <n>

Task:
${c.prompt}

When done:
1. Run sh scripts/full-test.sh in your worktree; record exit status honestly.
2. Emit your diff: git -C ${outDir}/wt-${c.key} diff > ${outDir}/${c.key}.diff
3. Return your meta summary as structured JSON.`,
      { agent: "task", schema: META_SCHEMA }
    ).catch((e) => ({ key: c.key, fixed: [], refuted: [], tests_added: [], full_suite_green: false, blockers: [`worker crashed: ${e}`] }))
  )
);

// --- persist meta; hand off to integration protocol --------------------------
for (const m of results) write(`${outDir}/${m.key}.meta`, JSON.stringify(m, null, 2));
log(
  `fix cycle ${cycle} complete. Diffs+meta in ${outDir}. ` +
  `NEXT: integrate one-by-one via skill://integrate-worker — every worker claim is unverified until re-proven on fresh trunk.`
);
