---
name: integrate-worker
description: "7-step protocol for integrating a fix-cycle worker's diff into Urtext trunk. Use whenever a urtext-fix-cycle worker has produced a .diff/.meta pair. The trust boundary lives here: every worker claim is unverified until re-proven on fresh trunk."
---

# integrate-worker — Urtext 集成协议

> Provenance: adapted from rue-language/rue `.claude/skills/integrate-worker/SKILL.md`,
> a battle-tested protocol from the 2026-06 autonomous runs (~30 PRs integrated).
> Each step exists because skipping it once caused a real failure. As Urtext
> accumulates its own incidents, append them here with issue numbers.

**信任边界在集成点。** worker 的一切声明（"全套测试绿"、"已复现"、"clause 映射正确"）
只对它的 worktree、它的 base 成立。视为未验证。

## 7 步协议（顺序执行，不可跳步）

### 1. 永远从新 trunk 开始

```bash
git fetch origin && git switch -c integrate/<key> origin/main
```

Urtext 单用 git（无 jj 双 VCS；Rue 弯路 #8 不适用——若将来引入第二 VCS，先回来补这一步的坑）。

### 2. 3-way 应用 diff

```bash
git apply --3way /tmp/urtext-fix/cycle-<N>/<key>.diff
```

冲突说明 worker 的 base 落后于 trunk。按**意图**而非按边解决：

- worker 改的代码 trunk 已删除 → 通常 worker 的修改已被包含，保留删除。
- 测试 fixture / registry 的 append-append 冲突 → 两边都保留。

### 3. 亲手重验每个 repro

对 meta 中每个 `fixed` 的 issue：在**当前 trunk + 该 diff** 上重跑原始 repro，确认由失败变通过。
对每个 `refuted`：确认 pin test 存在且通过。
worker 曾对过期 trunk 验证过修复——只有此步能抓住。

### 4. 写跨机制测试

若本 worker 与另一个（已合入或在途）worker 构建了**相互作用**的机制
（例：一个改 unmapped-change 检测、另一个改 provenance 落库），当场写组合测试。
worker 各自的测试看不到接缝；各自全绿的 worker 联合起来可以是错的（Rue 一晚两次 double-drop）。

### 5. 全套测试 + 格式化

项目全量测试命令 exit 0，格式化通过，才进入下一步。

### 6. 提交 / 发 PR

- commit message 引用 issue：`Fixes #NN` **每行一个**（逗号列表只会关闭第一个）。
- 附 meta 中的 clause 映射；`unmapped` 列表非空时，逐条裁决：回写 spec 或显式 manual-ack（VISION P3）。

### 7. 处理弹回

兄弟 PR 先合入导致本 PR DIRTY 时：rebase 到新 trunk，解决冲突时**保住两个 PR 的语义**，
重跑自己和兄弟的 repro，再全套测试。

## 车道纪律（Lane discipline）

并行 worker 只能跨**不相交的模块集合**，永不共享热点文件。热点文件必须串行（合一个再派下一个）。

当前热点清单（人工维护，代码落地后随实际冲突记录更新）：

| 热点 | 原因 |
|---|---|
| linker 的 clause 注册表 | 所有 clause 注册路径汇聚点 |
| oracle 类型定义 / schema | 每种 oracle 的执行器都依赖 |
| unmapped-change 检测入口 | P3 执法单点 |

## 模型策略

集成判断使用最强模型，保留给主 loop，不下放给 worker。
