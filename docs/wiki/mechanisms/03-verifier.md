# The Verifier

`urtext verify` is where intent meets evidence. It indexes, checks, then runs
every `ready` clause's oracle, records the result as append-only evidence, and
reports a pass-rate. The exit code is the whole point: a single failing clause
turns the command red.

## What a run does

```text
index → take each ready revision's clauses → run the oracle → record evidence → report
```

The verdict table is small and total — there is no "skipped" that hides:

| Oracle kind | How it runs | Verdict |
|---|---|---|
| `test` | `npx vitest run <ref>` | exit 0 → pass |
| `cmd` | run `<ref>`, `%20`-separated args (e.g. `scripts/x.sh%20arg`) | exit 0 → pass |
| `diff-scope` | `git diff --name-only HEAD` against the allowed globs | empty violation set → pass |
| `manual` | not executed | pending (awaits a human, counts toward manual share) |
| `metric` | not supported in v0 | fail (explicit, never a silent skip) |

Exit code: any `fail` → 1; `pending` does not block (its human adjudication is the
[Decision ledger](07-unsafe-lane.md)'s job). The evidence row carries `spec_path,
revision, clause_id, oracle_kind, oracle_ref, verdict, exit_code, output,
created_at` plus a mutable `invalidated_at`. It is append-only in the strict
sense — rows are never deleted or rewritten — with the single exception of
`invalidated_at`, which the [linker](04-linker-impact.md) stamps to void stale
evidence without erasing it.

## The self-hosted proof

Urtext describes its own behavior in `specs/urtext/` and proves it by running
`urtext verify` on itself. This is the closed loop — the minimal evidence that the
design holds. Here is a sample run (from a mid-development commit — current counts
will differ):

```text
$ urtext verify
  ...
  ✓ C001 无 oracle 的规范性子句被拒绝 [high] (test, pass)
  ✓ C004 oracle 执行产出证据并驱动退出码 [high] (test, pass)
  ✓ C009 clause→code 映射由真实 diff 交叉验证 [high] (test, pass)
  ✓ C012 风险分级裁决门 [high] (test, pass)
  ✓ C013 unsafe lane：高危子句需绑定 HEAD 的人工代码审查 [high] (test, pass)
  ? C006 CLI 帮助面命令集变更需人工确认 (manual, pending)
  ? C504 模型路由是人类决策 (manual, pending)

34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13%
```

Read the last line carefully, because it is the philosophy in three numbers:

- **`34 pass, 0 fail`** — completion is an *aggregate of objective evidence*, not
  a score an AI assigned. Every green mark is an oracle that actually ran and
  exited zero.
- **`pass rate 100%`** — this is passes over *decided runnable* clauses
  (`pass / (pass + fail)`); `pending` (manual) clauses are excluded from the
  denominator, not scored as failures. It is the fraction of runnable checks that
  are green, nothing interpretive.
- **`manual share 13%`** — the load-bearing health metric, and a *separate* ratio:
  manual clauses over *total* clauses. Thirteen percent fall back to a human check.
  Every `verify` prints this share and warns above 50%; a rising trend means the
  [central bet](../concepts/03-why-decidable.md) is failing. Thirteen is
  comfortably under the line.

## Completion is an aggregate, not an opinion

The reason `verify` never asks a model "is this good enough?" is
[same-source verification](../concepts/03-why-decidable.md): an AI grading its own
output only proves self-consistency. The verifier replaces the opinion with a
count. Whether that count *truly* covers each clause's meaning — whether an oracle
is too weak or a test cheats — is a separate, meta-level question handled by
[Meta-Audit and the Gate](06-meta-audit-gate.md).

Before that, one more mechanism answers "if I change this clause, what breaks?":
[the linker](04-linker-impact.md).
