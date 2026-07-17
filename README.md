# Urtext

English | [简体中文](README.zh-CN.md)

> **The ur-text of your system. Code is just an interpretation.**

In classical music publishing, an *Urtext* edition strips away generations of
editorial alterations to recover the composer's original intent — the single
authoritative source every performance answers to.

Urtext applies the same discipline to software built with AI coding agents:

- **Humans maintain system intent** — specs, designs, interaction demos,
  acceptance checklists.
- **AI maintains the projection** — the code.
- **Every normative statement binds an oracle** — an executable check that
  decides, with evidence, whether the intent holds.
- **Unmapped changes must flow back** — code edits that answer to no spec
  clause are surfaced, never silently absorbed.

## Quick start

```bash
npm install -g urtext
cd your-repo
mkdir -p specs/coupon
```

Declare intent as clauses (`specs/coupon/spec.md`) — a clause is a heading
with a `C<n>` id, and **every clause must bind an oracle**:

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

Bind acceptance tasks to clauses (`specs/coupon/tasks.md`):

```markdown
- [ ] T001 Implement stacking guard <!-- role:coder gate:true clauses:C001 -->
    Reject on the apply path.
```

Validate, then run the oracles and record evidence:

```bash
urtext check   # exit 1 if any clause lacks an oracle, any ref dangles, …
```

```bash
urtext verify  # exit 1 if any clause's oracle fails; evidence lands in .urtext/registry.sqlite
```

A normative statement that cannot be checked is an authoring error — not a
softer kind of truth. See [docs/VISION.md](docs/VISION.md) for the principles,
[docs/DESIGN.md](docs/DESIGN.md) for the seven subsystems, and
[docs/SYNTAX.md](docs/SYNTAX.md) for the v0 grammar.

## Documentation

The [documentation wiki](docs/wiki/index.md) reads in three layers — **concepts**
(why decidable specs are a paradigm shift), **mechanisms** (how the loop closes),
and **guides** (put it to work). Start with the
[Quickstart](docs/wiki/guides/01-quickstart.md), or read
[Urtext vs Spec-Driven Development](docs/wiki/concepts/04-vs-spec-driven-dev.md)
for how it differs from Spec Kit and its peers.

中文版本见[中文文档 Wiki](docs/wiki/app/content/zh/index.md)。

## Status

v0 closed loop, self-hosted: Urtext describes its own core behavior in
`specs/urtext/` and `urtext verify` proves it — clause/checklist parsers,
immutable-revision registry, oracle runner (test/cmd/diff-scope/manual),
append-only evidence, pass-rate + manual-share reporting. Next milestones:
clause linker (impact analysis) and clause↔code↔evidence mapping.

## License

MIT
