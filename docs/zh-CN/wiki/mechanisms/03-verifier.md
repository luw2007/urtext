# 验证器(verifier)

`urtext verify` 是意图遇见证据(evidence)的地方。它会索引、检查，然后运行
每个 `ready` 子句(clause)的 oracle(判据)，将结果记录为追加式证据，并
报告通过率(pass rate)。退出码就是全部要点：单个失败子句
就会让命令变红。

## 一次运行会做什么

```text
index → take each ready revision's clauses → run the oracle → record evidence → report
```

判定表很小且完备 — 没有会隐藏问题的“skipped”：

| Oracle 种类 | 如何运行 | 判定结果 |
|---|---|---|
| `test` | `npx vitest run <ref>` | 退出 0 → pass |
| `cmd` | 运行 `<ref>`、以 `%20` 分隔参数（例如 `scripts/x.sh%20arg`） | 退出 0 → pass |
| `diff-scope` | 对允许的 globs 运行 `git diff --name-only HEAD` | 违规集合为空 → pass |
| `manual` | 不执行 | pending（等待人工，计入 manual 占比(manual share)） |
| `metric` | v0 中不支持 | fail（明确失败，绝不静默跳过） |

退出码：任何 `fail` → 1；`pending` 不阻塞（它的人工裁定是
[决策账本](07-unsafe-lane.md)的工作）。证据行携带 `spec_path,
revision, clause_id, oracle_kind, oracle_ref, verdict, exit_code, output,
created_at`，外加一枚逻辑作废戳：`invalidated_at` 与
`invalidation_source` 由[链接器(linker)](04-linker-impact.md)同一次写入。
行仍保持追加式；陈旧证据永不删除，历史 NULL source 保持未知且绝不回填。

## 自托管证明

Urtext 在 `specs/urtext/` 中描述自己的行为，并通过在自身上运行
`urtext verify` 来证明它。这就是闭环 — 证明该设计成立的
最小证据。下面是一次示例运行（来自开发中期的某个提交 — 当前计数
会有所不同）：

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

34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13% (12.7s)
```

仔细读最后一行——这是用三个比率加一个墙钟表达的哲学：

- **`34 pass, 0 fail`** — 完成是*客观证据的聚合*，而不是
  AI 给出的分数。每一个绿色标记都是一个实际运行并且
  以零退出的 oracle。
- **`pass rate 100%`** — 这是*已判定且可运行*子句上的通过数
  （`pass / (pass + fail)`）；`pending`（manual）子句被排除在
  分母之外，而不是被记为失败。它只是可运行检查中
  变绿的比例，没有解释性含义。
- **`manual share 13%`** — 承重的健康指标，而且是一个*单独*比率：
  manual 子句占*全部*子句的比例。13% 回退到人工检查。
  每次 `verify` 都会打印这个占比，并在超过 50% 时警告；上升趋势意味着
  [中心赌注](../concepts/03-why-decidable.md)正在失败。13% 舒适地
  低于这条线。
- **`(12.7s)`** — 整次运行的墙钟耗时。它*不是*逐子句耗时之和：test oracle 共享同一个批量 vitest 进程，所以各部分永远加不成整体。

## 批量执行与增量复用

test oracle 在**单个批量 vitest 进程**中运行——不同 ref 去重，逐子句判定由 vitest 的 JSON 报告按子串 ref 语义归因，遇到未匹配 ref、批量失败或无法解释的非零退出时一律 fail-closed。因为所有子句共享同一进程，逐子句耗时不再等于墙钟耗时。设置 `URTEXT_VERIFY_BATCH=0` 可回退到逐 ref 运行。

`urtext verify --incremental` 在工作区指纹（HEAD + 已跟踪 diff + 未跟踪内容 + 运行时身份）未变时复用通过且未失效的 `test`-oracle 判定；被复用的判定不追加证据行。任何 git 可见改动、`fail`、已失效判定、非 `test` oracle 或修订为新增的子句都会强制重新执行。

## 完成是聚合，不是意见

`verify` 从不询问模型“这是否足够好？”的原因是
[同源验证](../concepts/03-why-decidable.md)：让 AI 给自己的
输出打分，只能证明自洽。验证器用一个
计数替代意见。这个计数是否*真正*覆盖每个子句的含义 — 一个 oracle
是否太弱，或测试是否作弊 — 是另一个元层面问题，由
[元审计与裁决门](06-meta-audit-gate.md)处理。

在那之前，还有一个机制回答“如果我改变这个子句，什么会坏？”：
[链接器](04-linker-impact.md)。