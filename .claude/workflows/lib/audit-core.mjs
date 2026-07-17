/**
 * urtext spec-audit core.
 *
 * Four lenses run in parallel. Auditors return structured findings only; the
 * caller owns synthesis, deduplication, and issue filing.
 */

const FINDING_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["lens", "severity", "clause_ids", "title", "detail", "ran"],
        properties: {
          lens: { enum: ["drift", "soundness", "consistency", "formal"] },
          severity: { enum: ["critical", "high", "medium", "low"] },
          clause_ids: { type: "array", items: { type: "string" }, description: "exact clause ids; empty only for uncovered-behavior findings" },
          title: { type: "string" },
          detail: { type: "string" },
          ran: { type: "string", description: "exact command(s) actually executed and observed result — findings without a RUN are inadmissible for behavioral claims" },
        },
      },
    },
  },
};

const COMMON = `
You are one lens of the Urtext spec audit. Read docs/VISION.md first.
Specs are markdown files containing clauses (HTML-comment anchors with stable
ids, each binding an oracle: test / cmd / metric / diff-scope / manual).

Rules:
- Return structured findings ONLY. Change NOTHING. File NO issues.
- Every behavioral claim must be RUN: execute the oracle / command and report
  the actual observed result in the 'ran' field. No run, no behavioral finding.
- Cite exact clause ids.
- If the spec corpus does not exist yet, return empty findings — do not invent.`;

const LENSES = {
  drift: `${COMMON}
LENS: DRIFT — spec vs implementation.
For recently shipped behavior, is the spec still true? Find:
- clause statements that have become false (RUN their oracles; a clause whose
  oracle no longer exists or no longer executes is drift, severity high),
- implemented behavior (CLI flags, oracle types, detection paths) with NO
  clause coverage,
- examples embedded in specs that no longer run (RUN every example in
  recently-changed sections).`,

  soundness: `${COMMON}
LENS: SOUNDNESS (adversarial).
Assume the toolchain faithfully implements the LITERAL clause text. Construct
scenarios the clauses PERMIT that nevertheless violate Urtext's core guarantees:
- a code change that corrupts spec↔code provenance yet triggers no unmapped-change
  detection (fact-source inversion bypass, P3),
- an oracle that is green while the clause's semantic intent is violated
  (same-origin trap, P2: test asserts nothing, cmd exits 0 unconditionally,
  metric threshold vacuous),
- a high-risk / unsafe path that can auto-pass without a human gate (P4/P5).
For each: RUN it. If the toolchain permits it → critical (clauses AND toolchain
wrong). If the toolchain rejects it → high (clauses weaker than implementation).`,

  consistency: `${COMMON}
LENS: CONSISTENCY — the spec corpus against itself.
Find: clauses that contradict each other; examples that disagree with their
clause (RUN the examples); oracle bindings whose description mismatches what
the oracle actually checks (RUN it); terminology whose meaning drifts across
files (check against the VISION §五 glossary: clause, oracle, evidence, linker,
DWARF layer, unmapped change, unsafe, meta-verification); dead cross-references
(links to clause ids that no longer exist).`,

  formal: `${COMMON}
LENS: FORMAL — prose clauses vs machine-readable layer.
Compare clause prose against its machine-readable binding (anchor metadata,
oracle definitions, linker registry). Find: prose without a binding
counterpart; bindings without prose; places where the authoritative side is
undeclared (which wins on disagreement?); notation/fields used but never
defined. Judge whether each clause's prose and its oracle actually denote the
same predicate — a mismatch here is exactly how "Gate coarseness" sneaks in.`,
};

export async function run(runtime) {
  const results = await runtime.parallel(
    Object.entries(LENSES).map(([lens, prompt]) => () =>
      runtime.adapters.agent(prompt, { agent: "task", schema: FINDING_SCHEMA })
        .then((result) => result.findings ?? [])
        .catch((error) => (runtime.log(`lens ${lens} crashed: ${error}`), []))
    )
  );
  const findings = results.flat();
  const stamp = new Date().toISOString().slice(0, 10);
  await runtime.write(`/tmp/urtext-audit-${stamp}.json`, JSON.stringify(findings, null, 2));

  const bySeverity = { critical: [], high: [], medium: [], low: [] };
  for (const finding of findings) bySeverity[finding.severity].push(finding);
  runtime.log(
    `spec audit ${stamp}: ${findings.length} findings ` +
    `(critical ${bySeverity.critical.length}, high ${bySeverity.high.length}, ` +
    `medium ${bySeverity.medium.length}, low ${bySeverity.low.length}). ` +
    `Full JSON: /tmp/urtext-audit-${stamp}.json. ` +
    `NEXT: dedupe against open issues, then file criticals/highs via gh; ` +
    `criticals touching P3 enforcement or human gates escalate to the human immediately.`
  );
}
