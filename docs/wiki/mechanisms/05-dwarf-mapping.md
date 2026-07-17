# DWARF Mapping

The name is borrowed on purpose. DWARF is the debug-information format that
stitches compiled machine code back to the source that produced it — so a debugger
can show you a source line instead of a raw address. Urtext's DWARF layer aims at
the same goal for the AI-era abstraction: stitch **clause ↔ code** so a human can
ask "which clause constrains this line?" and get an answer.

This is the operational core of the [source-of-truth
flip](../concepts/05-source-of-truth-flip.md).

> **v0 scope.** This page describes what ships today: clause→code range storage,
> diff-verified provenance, unmapped-change detection, and a *manual* `blame`
> lookup. Automatic failure-to-clause attribution — an oracle or CI failure
> resolving to "violated C001" without a human running `blame` — is the design
> goal (VISION §2, condition 4), **not** yet wired into the verifier. The verifier
> names the clause it is iterating; it does not consult the code map.

## The mapping table

`urtext map` records a clause→code mapping into `clause_code_map(kind, spec_path,
clause_id, file_path, line_start, line_end, commit_sha, note)`. Two kinds live in
the same table:

- `kind=clause` — this code range is constrained by this clause.
- `kind=ack` — this range is an *intentionally unmapped* change, explicitly
  acknowledged with a reason.

Note the table stores clause and code only. There is no evidence foreign key —
the "clause ↔ code ↔ evidence" triple is the layer's ambition, but v0 persists the
clause↔code half.

## Provenance trusts the diff, never the self-report

Here is the mechanism that makes the flip enforceable rather than hopeful. When
`map` or `ack` records a range, that range must **overlap a hunk in the same file**
of the actual `git diff --unified=0 HEAD` at that moment. A claimed mapping whose
lines did not change is rejected.

Be precise about what this proves and what it does not:

- **It proves** that *at least one line* in the claimed range overlaps a current
  hunk in that file — you cannot record a mapping against a file nobody touched.
  It does **not** verify the whole claimed range changed: a claim for lines 1–100
  passes if only line 50 is in a hunk.
- **It does not prove** the change *satisfies* the clause, or even that this
  particular clause relates to the change — an unrelated but live clause with an
  overlapping range would be accepted. And nothing downstream re-checks the
  clause→code mapping's correctness: the [meta-audit](06-meta-audit-gate.md) reads
  clause text, oracle, and evidence output, but never the code map or diff, so
  mapping semantic correctness is simply **unchecked in v0**.

So provenance defeats the *fabricated* mapping (a claim against a file nobody
touched), which is the failure mode that matters most for the source-of-truth
flip. It is a weak-overlap provenance check, not a correctness check.

## Unmapped-change enforcement

`urtext check --diff` attributes every **tracked** working-tree hunk to one of
three things:

1. a clause mapping that hits the **current** HEAD, or
2. an explicit `ack`, or
3. a location inside `specs/<feature>/*.md` (a spec write-back is self-attributing).

Anything else is `unmapped`, and the command exits non-zero:

```text
  ⚠ unmapped src/foo.ts:12-18 — map to a clause, ack, or write back to spec
```

Hand edits are not forbidden. They are made **visible** and **required to flow
back**: a code hunk must be attributed by a `map` or an `ack`, while a hunk whose
own path is a spec Markdown file under `specs/<feature>/` (including prose and
`tasks.md`) is automatically self-attributed — writing intent back into the spec is
its own flow-back. That is the enforcement point for the source-of-truth flip. One
honest caveat: it acts on `git diff HEAD`, which sees **tracked** changes only. A
brand-new *untracked* file is invisible to `check --diff` (and `gate --diff`) until
it is `git add`-ed — so the enforcement covers edits to tracked code, not the
appearance of untracked files.

## Blame runs backward — by hand

`urtext blame <file>:<line>` answers the inverse question — which clause
constrains this line of code. It is a **manual lookup**: you run it, it reads the
code map, it reports. An unmapped line honestly says so:

```text
$ urtext blame src/verifier.ts:1
No clause constrains src/verifier.ts:1.
```

When a mapping exists, `blame` names the clause. Two v0 caveats: it returns **every
stored mapping** whose range overlaps the line — including mappings recorded
against older commits and clauses since removed — with no current-HEAD or
live-clause filter, so check the reported `commit_sha` to judge whether a mapping
still applies. And the attribution is a human running `blame`, not the verifier
doing it automatically.

## The v0 boundary

Ranges are anchored to `(file, lines, commit_sha)`, where `commit_sha` is the
**diff baseline** — the pre-change HEAD the working-tree diff was taken against.
The mapped lines are the *new* side of that diff and do not yet exist in that
commit; the SHA records what they were diffed from, not a commit that contains
them. If later edits move already-mapped lines, v0 does **not** re-anchor the
drifted range automatically — that follows in a later version. This is a
deliberate, marked simplification, not an oversight.

With intent and code stitched together, the last question is *who decides* — and
how the machine narrows a human's attention to only what needs it. That is
[Meta-Audit and the Gate](06-meta-audit-gate.md).
