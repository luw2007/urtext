# Urtext 系统设计（七子系统）

> 本文是面向 Urtext 的权威版本）。VISION.md 是原则层，本文是结构层，SYNTAX.md 是语法层。

## 总览

```text
意图 → Spec(子句+oracle) → Link(影响分析) → 人审 spec diff → Accept
     → 物化 checklist → AI 生成(带 provenance) → oracle 执行(证据)
     → 跨模型元验证 → 风险分级裁决 → 合并 → Decision/ADR 沉淀
```

| # | 子系统 | 职责 | v0 状态 |
|---|---|---|---|
| 1 | 语言层 | clause/oracle/refs/risk 四原语（SYNTAX.md） | ✅ parser + fail-closed 错误目录 |
| 2 | 注册表 | 不可变修订链（unchanged/indexed/tombstoned） | ✅ registry.sqlite |
| 3 | 验证器 | oracle 执行 → 证据落库 → 完成率 | ✅ `urtext verify` |
| 4 | Linker | refs 建图、stale 传播、`urtext impact` | ✅ `urtext impact` |
| 5 | DWARF | clause↔code↔evidence 映射、unmapped change 检测 | ✅ `urtext map/ack/blame`, `check --diff` |
| 6 | 裁决层 | 风险分级触发人工、跨模型元验证 | ✅ `urtext audit/gate` |
| 7 | 记忆层 | Decision/ADR 沉淀 | 里程碑 +3 |

## 关键设计决策（沉淀自奠基讨论，不可回退）

1. **无 oracle 的规范性子句 = 索引错误**（P1）——语言与文档的分界线。
2. **完成率 = 证据通过率**，AI 不打分（P2）；跨模型对抗只用于元层。
3. **事实源翻转靠执法**（P3）：unmapped change 必须回写 spec 或显式 ack。
4. **风险分级触发人工**（P4）：low+全绿自动过；high/分歧/unmapped 必人审。
5. **unsafe 承认 spec 极限**（P5）：money path/迁移/并发上代码仍需人审。
6. **manual oracle 占比是健康度指标**（P9）：持续 >50% 即宣告承重假设失败。

## 验证器（v0 实现范围）

`urtext verify`：index → 取每个 `ready` 修订的子句 → 执行 oracle → 证据落库 → 报告。

| oracle kind | 执行方式 | verdict |
|---|---|---|
| `test` | `npx vitest run <ref>` | 退出码 0 → pass |
| `cmd` | 执行 `<ref>`，`%20` 分隔参数（如 `scripts/x.sh%20arg`） | 退出码 0 → pass |
| `diff-scope` | `git diff --name-only HEAD` 对照允许 glob | 违例集空 → pass |
| `manual` | 不执行 | pending（等待人工，计入 manual 占比） |
| `metric` | v0 不支持 | fail（显式，不静默跳过） |

退出码：任一 fail → 1；pending 不阻塞（人工裁决在后续里程碑接 Decision）。
证据表：`evidence(spec_path, revision, clause_id, oracle_kind, oracle_ref, verdict, exit_code, output, created_at)`，append-only。

## 自举闭环（dogfood）

Urtext 用自己描述自己：`specs/urtext/spec.md` 声明本系统的核心子句，
每条绑定真实 oracle（本仓库的测试与脚本）；`specs/urtext/tasks.md` 把实现任务映射到子句。
`urtext check && urtext verify` 全绿 = 设计闭环成立的最小证明。
