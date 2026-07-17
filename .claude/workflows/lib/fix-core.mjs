/**
 * urtext fix-cycle core.
 *
 * TRUST BOUNDARY: nothing a worker claims is verified. Diffs go through
 * .claude/skills/integrate-worker/SKILL.md before touching trunk. NEVER merge here.
 */

const MAX_WORKERS = 4;

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

export async function run(runtime) {
  const { cycle, clusters } = JSON.parse(await runtime.read(".claude/workflows/fix-cycle-input.json"));
  if (!Array.isArray(clusters) || clusters.length === 0) throw new Error("no clusters");
  if (clusters.length > MAX_WORKERS) throw new Error(`max ${MAX_WORKERS} parallel workers; serialize the rest`);
  const outDir = `/tmp/urtext-fix/cycle-${cycle}`;
  runtime.log(`fix cycle ${cycle}: ${clusters.length} workers -> ${outDir}`);

  const base = await runtime.adapters.worktree.head();
  for (const cluster of clusters) {
    await runtime.adapters.worktree.add(`${outDir}/wt-${cluster.key}`, base);
  }

  const results = await runtime.parallel(
    clusters.map((cluster) => () =>
      runtime.adapters.agent(
        `${PREAMBLE}
Your worktree: ${outDir}/wt-${cluster.key} (work ONLY there).
Your cluster key: ${cluster.key}. Issues: ${JSON.stringify(cluster.issues)}.
Fetch each issue body with: gh issue view <n>

Task:
${cluster.prompt}

When done:
1. Run sh scripts/full-test.sh in your worktree; record exit status honestly.
2. Emit your diff: git -C ${outDir}/wt-${cluster.key} diff > ${outDir}/${cluster.key}.diff
3. Return your meta summary as structured JSON.`,
        { agent: "task", schema: META_SCHEMA }
      ).catch((error) => ({ key: cluster.key, fixed: [], refuted: [], tests_added: [], full_suite_green: false, blockers: [`worker crashed: ${error}`] }))
    )
  );

  for (const meta of results) {
    await runtime.write(`${outDir}/${meta.key}.meta`, JSON.stringify(meta, null, 2));
  }
  runtime.log(
    `fix cycle ${cycle} complete. Diffs+meta in ${outDir}. ` +
    `NEXT: integrate one-by-one via skill://integrate-worker — every worker claim is unverified until re-proven on fresh trunk.`
  );
}
