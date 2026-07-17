# Urtext 文档

> **你的系统的 ur-text。代码只是其一种解释。**

在古典音乐出版中，*Urtext* 版本会剥离一代代
编辑改动，以恢复作曲家的原始意图——每一次演奏都要回应的唯一
权威来源。Urtext 将同样的纪律应用于用 AI 编码
agent 构建的软件：**人类维护系统
意图，AI 维护代码，而每一条规范性子句(clause)都绑定一个检查，
用证据(evidence)判定该意图是否仍然成立。** 在 v0 中，这些检查是
测试运行、命令退出码和 diff 范围边界；某些意图会回退
到一次已记录的人类决策。

大多数规范驱动工具止步于“写一份规范，然后生成”。Urtext 从
那里结束的地方开始：一句无法被检查的规范语句是一种编写
错误，而不是一种更柔性的真相。

## 分三层阅读

本文档映射了 Urtext 自身的构建方式——从 *为什么* 下探到
*如何做*，再下探到 *现在就做*。

### 概念 — 为什么可判定规范是一场范式转变

- [范式转变](concepts/01-paradigm-shift.md) — 你的工作对象从代码转移到系统认知。
- [从汇编到 C](concepts/02-assembly-to-c.md) — 一次真正的抽象跃迁需要满足的六个条件，以及它们在 AI 时代的对应物。
- [为什么规范必须可判定](concepts/03-why-decidable.md) — 一门语言与一份文档之间的界线。
- [Urtext vs 规范驱动开发](concepts/04-vs-spec-driven-dev.md) — Spec Kit 及其同类共有的东西，以及它们留给纪律约束的一件事。
- [真相源翻转](concepts/05-source-of-truth-flip.md) — 为什么规范腐化要靠执行约束阻止，而不是靠约定。
- [Urtext 隐喻](concepts/06-metaphor.md) — ur-text、解释和音叉。

### 机制 — 循环如何闭合

- [子句与 oracle](mechanisms/01-clause-and-oracle.md) — 语言层的四个原语：子句、oracle(判据)、refs(引用)、risk(风险级别)。
- [注册表(registry)](mechanisms/02-registry.md) — 不可变的修订链。
- [验证器(verifier)](mechanisms/03-verifier.md) — oracle 运行，证据落地，通过率(pass rate)聚合。
- [链接器(linker)](mechanisms/04-linker-impact.md) — 引用图与失效传播。
- [DWARF 映射](mechanisms/05-dwarf-mapping.md) — 子句↔代码存储、手动 `blame`，以及未映射改动的强制约束。
- [元审计(meta-audit)与裁决门(gate)](mechanisms/06-meta-audit-gate.md) — 跨模型验证与风险分级裁决。
- [不安全通道(unsafe lane)](mechanisms/07-unsafe-lane.md) — 代码仍然是唯一可评审事实的地方。

### 指南 — 投入使用

- [快速开始](guides/01-quickstart.md) — 十分钟写出你的第一个子句。
- [编写子句](guides/02-authoring-clauses.md) — 粒度与 oracle 选择的技艺。
- [命令参考](guides/03-command-reference.md) — 全部十二个命令、退出码和证据。
- [持久化模型](guides/04-persistence-model.md) — Urtext 对规范持久化问题的回答。
- [采用方式与边界](guides/05-adoption-and-limits.md) — 如何开始，以及什么时候*不该*使用 Urtext。

## 状态

**v0 闭环，已自举。** Urtext 在
`specs/urtext/` 中描述自己的核心行为，而 `urtext verify` 证明这一点：
子句和清单解析器、一个
不可变修订 registry、一个 oracle runner（`test` / `cmd` / `diff-scope` /
`manual`）、只追加证据，以及通过率加人工占比报告。
子句链接器、DWARF 映射、跨模型元审计、风险分级裁决门和
不安全评审通道都已在 v0 交付。视觉与交互 oracle 已为
v1 命名但尚未实现——本文档会在相关位置标出这条边界。
