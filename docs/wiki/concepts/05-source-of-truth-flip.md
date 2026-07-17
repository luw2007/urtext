# The Source-of-Truth Flip

When C displaced assembly, one cultural change did more work than the syntax ever
did: **hand-editing the compiler's output became taboo.** You changed the C
source and recompiled. Editing the generated assembly directly was not a
shortcut — it was a bug waiting to happen, because the source no longer described
what actually ran.

Urtext calls this the **source-of-truth flip**, and it is the hardest of the six
[assembly-to-C conditions](02-assembly-to-c.md) to reproduce in the AI era —
because nothing stops a developer from editing the code directly and never
telling the spec.

## The question Spec Kit leaves open

Spec Kit is admirably honest about this. Its spec-persistence models name
three strategies for what happens to `spec.md`, `plan.md`, and `tasks.md` after
requirements change:

- **Flow-back** — edit any artifact, then reconcile the set by hand.
- **Flow-forward** — freeze completed artifacts; create a new feature directory
  for new requirements.
- **Living spec** — edit `spec.md` first; regenerate the derived artifacts.

And then it says the decisive thing out loud:

> "The model is a team convention, not a CLI setting."

That is a clear-eyed admission, not a flaw. But it means the defense against spec
rot is *discipline* — and every one of the three models lists its own failure
mode as "silent drift," "duplicate context," or "lost rationale." When the team
gets busy, the convention is the first thing to go.

## Urtext's answer: enforcement, not convention

Urtext takes the same three temporal stances Spec Kit describes — it keeps
completed revisions as immutable history (like flow-forward) and propagates
change through the reference graph (like living spec) — but it refuses to leave
the flip to a convention. Three mechanisms enforce it:

1. **Unmapped-change detection.** `urtext check --diff` scans every *tracked*
   working-tree hunk. A change that cannot be attributed to a clause mapping, an
   explicit acknowledgment, or a spec write-back is flagged `unmapped`, and the
   command exits non-zero. (It reads `git diff HEAD`, so a brand-new *untracked*
   file slips through until it is `git add`-ed — a v0 blind spot.) Hand edits are
   not forbidden — they are made *visible* and *required to flow back*.
2. **Provenance trusts the diff, not the LLM.** When an agent claims "this code
   satisfies clause C001," Urtext does not take its word. The claimed clause→code
   range must overlap a real hunk in the *actual* `git diff` at that moment, or it
   is rejected. This proves at least one claimed line genuinely changed — it
   defeats a *fabricated* mapping against an untouched file. It does not prove the
   whole range changed, that the change satisfies the clause, or even that this
   clause relates to it; mapping correctness is unchecked in v0 (the
   [meta-audit](../mechanisms/06-meta-audit-gate.md) reads evidence, not the code
   map). Provenance grounds *that something in the file changed*, not *whether it
   is correct*.

3. **Attribution runs backward — by hand in v0.** `urtext blame <file>:<line>`
   maps a code line back to the clause that constrains it, so a failure can be
   traced to intent instead of a stack frame. In v0 this is a human running
   `blame`; wiring the verifier to attribute failures automatically is the design
   goal ([DWARF](../mechanisms/05-dwarf-mapping.md)), not yet shipped. Without this
   backward link, a human is forced back down into the code layer.

## Why convention was never enough

The reason is not that teams are undisciplined. It is structural: a convention has
no failure signal. When someone edits the code and forgets the spec, nothing
turns red. The drift is silent by construction, and silent drift compounds until
no one knows which artifact to trust.

Enforcement supplies the missing signal. An unmapped hunk is a non-zero exit code
— the same kind of hard, unignorable failure that "don't hand-edit the assembly"
became once the compiler was trustworthy. That is the whole trick: **make the
thing you want to prevent produce a failure, and you no longer need everyone to
remember not to do it.**

The concrete implementation of all three mechanisms — the `clause_code_map` table,
diff cross-verification, and `urtext blame` — is documented in [DWARF
Mapping](../mechanisms/05-dwarf-mapping.md).
