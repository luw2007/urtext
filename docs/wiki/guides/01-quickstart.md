# Quickstart

Your first clause in ten minutes. The goal is not to specify a whole system — it
is to take *one* real requirement, make it decidable, and watch the loop close.

## Install

```bash
npm install -g urtext
```

Urtext is git-native and serverless: no daemon, no server, no workspace to create,
no orchestration model to learn. It does need Node.js 22+ and the npm package
(which pulls the native `better-sqlite3`). You start in a repository you already
have.

## 1. Declare intent as a clause

Pick one real requirement from whatever you are building. Create a feature
directory and write it as a clause — a heading with a `C<n>` id, and **every
clause must bind an oracle**:

```bash
cd your-repo
mkdir -p specs/coupon
```

```markdown
<!-- specs/coupon/spec.md -->
# Coupon rules

Descriptive prose is free — write whatever context you like here. Only headings
carrying a C-id become clauses.

## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

The oracle points at a test that does not exist yet. That is fine — it is exactly
the point. The clause is a decidable promise; the test is how it gets decided.

## 2. Bind an acceptance task

```markdown
<!-- specs/coupon/tasks.md -->
- [ ] T001 Implement the stacking guard <!-- role:coder gate:true clauses:C001 -->
    Reject an already-discounted item on the apply path.
```

## 3. Check the grammar

```bash
urtext check
```

`check` indexes your specs and fails closed. If C001 had no oracle, you would see
a `missing_oracle` error and the file would stop at `building` — it could never
run. A normative statement that cannot be checked is an authoring error, surfaced
now rather than discovered later.

## 4. Verify: run the oracle, record evidence

Write the test the clause named (`tests/coupon-stack.test.ts`), implement the
guard, then:

```bash
urtext verify
```

`verify` runs every clause's oracle and records append-only evidence in
`.urtext/registry.sqlite`. A single failing clause exits non-zero. When C001's
test passes, you get a line like:

```text
  ✓ C001 Coupons must not stack [high] (test, pass)

1 pass, 0 fail, 0 pending — pass rate 100%, manual share 0%
```

That green mark is not an AI's opinion that your code looks right. It is an oracle
that ran and exited zero — objective evidence that the intent holds.

## What you just proved

In four commands you closed the loop the rest of this documentation explains:

- The clause is **decidable** — it bound an oracle or `check` would have refused
  it ([why](../concepts/03-why-decidable.md)).
- Completion is **evidence, not a score** — the `pass rate` is green runnable
  clauses over decided runnable clauses ([the verifier](../mechanisms/03-verifier.md)).
- Because C001 is `risk:high`, its green evidence still will **not** auto-pass the
  [gate](../mechanisms/06-meta-audit-gate.md) — it routes to a human code review
  ([the unsafe lane](../mechanisms/07-unsafe-lane.md)).

## Next

- Write more clauses well: [Authoring Clauses](02-authoring-clauses.md).
- Learn every command: [Command Reference](03-command-reference.md).
- Understand when *not* to reach for Urtext: [Adoption and
  Limits](05-adoption-and-limits.md).
