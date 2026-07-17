# Urtext 与规范驱动开发

Urtext 和 [Spec Kit](https://github.github.io/spec-kit/) 生活在同一个世界。
二者都相信规范应先于实现定义*做什么*，再定义*怎么做*；二者都
拒绝一次性生成，转而采用多步精炼；二者也都把
治理置于代码之前。如果你读过 Spec Kit 的 SDD 概览，这套哲学
会让你感到熟悉。

> 对比固定在提交 `c47f334`（2026-05-26）的 Spec Kit checkout 上。它的
> 命令以 `/speckit.*` 命名空间区分（一个 spec/plan/tasks/implement 工作流，加上
> 可选的 `analyze`/`clarify`/`checklist`）。flow-back / flow-forward / living
> persistence 分类来自 Spec Kit 发布的概念文档
> (github.io)；它在这个 checkout 中并不是一个页面。请查看上游仓库
> 以了解后续变更。

差异不在哲学。差异在于**决定住在哪里。**

## 它们共享什么

- **意图先于实现。** Spec Kit：规范变成可执行内容，
  并生成实现。Urtext：人类维护意图，AI 维护
  投影。同一个北极星。
- **多步，而非一次性。** Spec Kit 通过
  `/speckit.constitution → .specify → .clarify → .plan → .tasks → .analyze →
  .implement` 精炼。Urtext 通过 `intent → clause → link → review →
  materialize → generate → oracle(判据) → adjudicate` 精炼。
- **治理优先。** Spec Kit 的 `/speckit.constitution` 设置元规则。
  Urtext 的设计原则（P1–P9）扮演同样角色——只是 Urtext 的
  constitution 本身会被编译成 `specs/urtext/` 下可检查的子句。
- **规范腐化是敌人。** Spec Kit 的规范持久化模型存在，正是因为
  需求会变化、产物会漂移。Urtext 的整套执行
  层也因同一原因而存在。

## 它们在哪里分叉

| 维度 | Spec Kit / SDD | Urtext |
|---|---|---|
| **规范句子是否可判定？** | `spec.md` 是自然语言；不可机械检查 | **没有 oracle = 语法错误。** 子句(clause)没有 oracle 就无法到达 `ready` |
| **完成度来自哪里？** | `/speckit.analyze` 运行一个由 LLM 驱动、只读的覆盖率与一致性报告（建议性） | **完成度 = 客观证据通过率(pass rate)。** AI 不打分 |
| **如何防止规范腐化？** | 三种*团队约定*（flow-back / flow-forward / living）——明确“不是 CLI 设置” | **未映射改动强制执行。** 没有子句的手动编辑会以非零退出 |
| **影响分析** | `/speckit.analyze`——LLM 对当前 spec/plan/tasks 的一次遍历 | 带有失效传播的 `refs(引用)` 图；`urtext impact` 机械地回答 |
| **失败归因** | 没有 spec↔code 映射；失败落在代码/测试层 | **DWARF 层（v0）：** `urtext blame` 把代码行映射回其子句（一次人工查找；自动归因是目标，尚未接线） |
| **执行范围** | 一个由 agent 驱动的 spec → plan → tasks → implement 命令工作流 | 刻意*不是*编排、CI 或仪表盘——只是“运行 oracle，返回证据” |
| **自证** | 文档描述流程 | **Dogfood：** `specs/urtext/` 用自身语法描述 Urtext；`urtext verify` 证明它 |

## 生命周期映射

Spec Kit 的命令链是 SDD 生命周期的清晰表达。Urtext 并不
替代它——它强化了 SDD 依赖纪律的两个环节：

- `/speckit.analyze` 会在 `spec.md`、`plan.md` 和 `tasks.md` 之间生成一个只读的覆盖率与一致性
  报告，并*建议*在实现前解决关键
  发现——但它不强制阈值，也不会阻止
  `/speckit.implement`；用户仍可继续。Urtext 的**裁决门(gate)**是被强制执行的
  对应物：它基于客观证据（对已判定
  可运行子句的通过情况，由证据行支撑）加上元审计(meta-audit)和评审，对每个子句作出决定，
  并在任何子句需要人类时以非零退出。
- `/speckit.implement` 会在每个任务之后写回状态。这正是
  规范腐化开始的地方，也是 Spec Kit 把问题交给持久化
  约定的地方。Urtext 则在那里放置一个**裁决门**：未映射的 hunk 必须回流
  到规范，或被显式确认，否则 `urtext check --diff` 会失败。

## 一句话差异

> Spec Kit 让团队*同意*保持规范权威。Urtext 使用
> 不可变注册表(registry)和未映射改动强制执行，把这种权威变成
> *裁决门*，而不是承诺。

每篇 SDD 文章都会点名同样三种反模式——模糊裁决门、规范腐化和
迭代中漂移——并开出模板、评审规范和清理
说明来对抗它们。这些都依赖纪律，而依赖纪律的
规范腐化解决方案已经反复被证明会失败。Urtext 的贡献
是用机制替换三者中的每一个：

| 反模式 | 依赖纪律的修复（已被证明会失败） | Urtext 的机制 |
|---|---|---|
| 模糊裁决门（“我们赶时间”） | 模板和评审规范 | 仅在这一点上强制：没有 oracle = 永远到不了 `ready` 的语法错误。量化措辞以及捕获作弊 oracle 仍属于编写 + 元审计关注点 |
| 规范腐化（实现后没有写回） | “彻底实现并删除旧文件” | 未映射改动强制执行 |
| 迭代期间漂移 | 手动同步历史文档 | 链接器(linker)失效传播 + `urtext impact` |

承载最重重量的机制——把“保持规范
权威”从约定变成强制翻转——是
[下一个概念](05-source-of-truth-flip.md)的主题。
