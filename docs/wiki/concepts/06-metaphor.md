# The Urtext Metaphor

The name is not decoration. It is the most precise available description of what
the system does, borrowed from a discipline that solved a structurally identical
problem centuries ago.

## The ur-text of a score

In classical music publishing, an *Urtext* edition is the scholarly reconstruction
of a composer's original intent — the score with generations of editorial
"improvements" stripped back out. Over decades, editors add fingerings, dynamics,
and phrasing that were never in the manuscript. An Urtext edition is the single
authoritative source that every honest performance answers to.

The mapping to software built with AI agents is exact:

| Urtext publishing practice | This system |
|---|---|
| The ur-text is the sole authority; a performance is an interpretation | The spec is the source of truth; code is a projection |
| Every performance can differ | LLM stochasticity — the same spec generates different code each run |
| Whether it is out of tune is decidable | The oracle |
| The critical apparatus cites the basis for every reading | Evidence plus provenance |
| Editorial additions must be marked as distinct from the manuscript | Unmapped-change enforcement |
| Collating multiple manuscripts to establish the text | Cross-model meta-verification |
| A score corrupted by generations of editors | Spec rot |

## The roles follow the metaphor

Once the artifact is a score, the cast is obvious:

- **The conductor is the human.** They read the full score and rule on whether the
  performance is faithful — they do not play an instrument.
- **The players are the AI agents.** They realize the score into sound.
- **The performance is the code.** Real, particular, different every time.
- **The tuning fork is the oracle.** The external reference that decides, without
  argument, whether a note is in tune.

Notice what the conductor does *not* do: play. The human is not in the loop to
write code. The human is in the loop to decide, against an authoritative source,
whether the projection is faithful — and to be pulled in only when the tuning
fork is silent (a `manual` clause), the stakes are high (`risk:high`), or the
players disagree (a meta-audit dispute).

## Why the product is the score, not the conductor

A subtle naming lesson sits inside the metaphor. The product is **the ur-text on
the conductor's stand — not the conductor.** A tool is named for *what it is*, not
for *who uses it*.

This is why five earlier rounds of candidate names were rejected: *tenet, oath,
seal, score, conductor,* and the whole musician family. "Contract / orchestration
/ score" is the first-instinct vocabulary of programming-language authors, and
three generations of tools already occupy that semantic field. The good name
lives one layer out — in the *carrier, the ritual, the credential* — not in the
core concept word itself. **Urtext** is the credential: the authoritative source
every interpretation answers to.

The tagline spells this out so the borrowed word carries its own gloss: *the
ur-text of your system. Code is just an interpretation.*
