# L1.5 决策寻址 + L2 接口边界 —— 以验证之名（P3/P4 收益）

> 状态：v2，待批准。v1 经 sol（gpt-5.6-sol）review 修订，review 存档于 `.omx/artifacts/ask-pi-sol-l15-l2-plan-review-20260805.md`。
> 来源：`urtext-20260730-semantic-space-invertibility.md` §6.1/§6.2 的验证侧子集。
> 明确不做：`regen-equiv` oracle、fiber.md、diff 发现循环、签名级契约（文件级先行，deliberate simplification）。

## 目标

1. **L1.5 决策可寻址**：clause 通过 `dec:D<n>` 锚点机械引用 `docs/DECISIONS.md` 条目；断链 = link 错误（fail-closed）。
2. **L2 接口 surface**：声明式 contract 工件；unmapped hunk 分类为**命中接口 surface（风险升级信号）** vs 内部改动，提升 P4 信噪比。（v1 的"跨边界"措辞已废——文件级匹配只能证明 touches，不能证明 crosses。）

## 现状依据（scout 报告）

- 锚点语法通用（`src/anchor.ts` L20-39 已解析任意 key:value），只缺消费者。
- clause 语法消费字段仅 `oracle|risk|refs|req`（`src/clause-parser.ts` L307-345）。
- `docs/DECISIONS.md` 已有 `## D1..D10` 标题，纯散文，无机器 ID。
- `detectUnmapped`（`src/dwarf.ts` L384-432）：hunk 只有 accounted/unmapped 二分。
- `gate.adjudicate`（`src/gate.ts` L181-184）：unmappedCount>0 → human，不分层级。
- 先例：`clause_refs` fail-closed 解析（`src/linker.ts` L130-178）。

## 设计

### A. L1.5 —— `dec:` 锚点字段

**语法**：`<!-- oracle:... risk:high req:FR006 dec:D4 -->`，逗号列表。

**D-ID canonical form**：`D[1-9][0-9]*`，大小写敏感。`D01`/`d1` → clause-parser 错误 `invalid_dec_ref`；`dec:D1,D1` → `duplicate_dec_ref`；同一锚点重复出现 `dec:` key → `malformed_anchor`（沿用现有语义）。

**决策注册表**：`src/decisions-doc.ts` 解析 `docs/DECISIONS.md` 的 `## D<n> <title>` 标题。不建新存储，markdown 即真相源（P6/P8）。路径不隐式取 cwd：作为显式输入传入 linker，由现有 project-root 解析逻辑提供。

**缺失/损坏三分**（fail-closed，不静默降级）：
- 全仓库无 `dec:` 引用 + 无 DECISIONS.md → 兼容通过。
- 有 `dec:` 引用但文件不存在 → `missing_decisions_doc` 错误。
- 文件存在但无法解析/D-ID 重复 → `duplicate_dec_id` 等解析错误，link 失败。
- 引用的 D-ID 不在注册表 → `unknown_dec` 错误。

**supersede**：`## D4 ... <!-- superseded-by:D12 -->`。校验：目标必须存在（`unknown_supersede_target` 错误）、禁自指与环（`supersede_cycle` 错误）。clause 引用被 supersede 的条目 → warning `superseded_dec`，携带**直接**替代 ID（不解析链到末端——链信息读者自己顺着走，避免隐藏中间历史）。

**warning 传播**：linker 结果新增 `warnings` 数组；`check` 与 `gate` 文本及 JSON 输出均显示；不影响退出码。同一 D-ID 多 clause 引用不去重（每条引用是独立事实）。

**append-only 措辞诚实化**：本期提供的是 append-only **约定** + supersede **表达能力**，不是 enforcement（真 enforcement 需跨历史比较，超范围；SYNTAX.md 如实写）。

**迁移**：grep 找出 spec.md 散文决策引用（C009→D4、C011→D3 等），**逐条人工确认是规范依赖而非举例/历史叙述**后补 `dec:` 锚点；散文保留。

### B. L2 —— 接口 surface contract

**工件**：`specs/<feature>/contract.md`：

```markdown
## I001 registry schema <!-- surface:src/registry.ts,src/dwarf.ts -->
```

- `I<n>` = 命名接口；`surface:` = 逗号分隔路径/glob；正文散文自由描述签名/schema/不变式（不校验）。
- 解析器 `src/contract-parser.ts`，复用 anchor.ts；错误码 `missing_surface`、`duplicate_interface_id`、`invalid_surface_path`。

**路径语义（钉死）**：
- repo-root-relative POSIX path，整路径匹配。
- 禁绝对路径、禁 `..` 越界（→ `invalid_surface_path`）。
- glob 支持 `*`（单段）与 `**`（跨段），语义按现有依赖实现（无现成依赖则手写最小匹配器，两种通配符之外不支持）。
- rename hunk 同时以 old path 与 new path 匹配；delete 以 old path；binary/无 hunk 文件按文件路径整体匹配。

**发现与聚合**：从 repo root 聚合**所有** `specs/*/contract.md`；同一路径被多个 feature/接口声明 = 合法重叠。文件不存在 → 兼容（等同无 contract）；存在但 malformed → `check`/`gate` fail-closed 报错，**绝不静默降级为无 contract**。

**分类器与 dwarf 解耦**：`detectUnmapped` 不动。新增纯函数：

```ts
classifyUnmapped(unmapped, contracts) → { ...hunk, matchedInterfaces: string[] }  // 排序去重
```

**status（P4 收益点）**：
- `matchedInterfaces` 非空 → `effectiveRisk = max(existingRisk, 'high')`——**只升不降**，不覆盖既有 high。
- 命中项排人工队列最前；NEXT_HINT 附 `touches I002 (registry schema)`。

**gate/CLI 报告字段**（守恒关系明确）：
- `unmappedCount`：总数（含义不变）。
- `interfaceSurfaceUnmappedCount`：命中 surface 的子集。
- 恒等式：`internalUnmapped = unmappedCount − interfaceSurfaceUnmappedCount`。
- 裁决语义不变（所有 unmapped 仍需处理）；JSON schema 加字段为兼容性扩展，相关快照测试随之更新。

### C. 自我引用（dogfood）

- `docs/DECISIONS.md` 追加**两条**：D11（`dec:` 语法）、D12（contract 工件）——独立机制独立 supersede。
- `specs/urtext/spec.md` 新 clause 覆盖两个新行为，绑定 oracle:test；`specs/urtext/contract.md` 建立自身 surface 声明。
- 本仓库加入 contract.md 后即离开 absent-artifact 路径 → **另设 fixture 仓库/临时目录测试**专门验证无 contract、无 dec: 时行为与现状一致。
- `docs/SYNTAX.md` 补 `dec:`、D-ID canonical form、supersede、contract.md 语法与路径语义。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/decisions-doc.ts` | 新增：DECISIONS.md → 决策注册表（含 supersede 校验） |
| `src/contract-parser.ts` | 新增：contract.md → 接口条目（含路径校验） |
| `src/contract-classify.ts` | 新增：classifyUnmapped 纯函数 + glob 匹配 |
| `src/clause-parser.ts` | 消费 `dec:`；`invalid_dec_ref`/`duplicate_dec_ref` |
| `src/linker.ts` | dec 解析三分错误 + `superseded_dec` warning + warnings 数组 |
| `src/status.ts` | matchedInterfaces → effectiveRisk max 合成 + 排序 + hint |
| `src/gate.ts` | `interfaceSurfaceUnmappedCount` 报告字段 |
| `src/cli.ts` | check/gate 输出 touches 标记与 warnings |
| `specs/urtext/spec.md` | 迁移决策引用（人工确认）；新 clause |
| `specs/urtext/contract.md` | 新增 |
| `docs/DECISIONS.md` | D11、D12 |
| `docs/SYNTAX.md` | 语法文档 |
| tests | 见验证 |

## 验证（step → verify）

单测：
1. decisions-doc：D-ID 提取、重复、缺失/空文件、supersede 目标不存在/自指/环/链。
2. clause-parser：`dec:` 合法/`D01`/`d1`/尾逗号/空 token/列表重复/锚点重复。
3. linker：`missing_decisions_doc` vs `unknown_dec` 区分；`superseded_dec` warning 携带 replacement 且出现在结果 warnings。
4. contract-parser：surface 解析、`invalid_surface_path`（绝对路径、`..`）、重复 I-ID。
5. contract-classify：exact/`*`/`**`、多 I-ID 命中排序去重、rename(old+new)/delete/binary、多 feature 聚合重叠。
6. status：命中升 high、既有 high 不被降级、排序置顶。
7. gate：`unmappedCount = interfaceSurfaceUnmappedCount + internal` 守恒。

集成：
8. malformed contract.md → `check`/`gate` 失败（非静默降级）。
9. absent-artifact fixture（临时目录）：无 contract/无 dec: 时输出与现状语义一致。
10. CLI 集成：check/gate 文本与 JSON 输出含新字段与 warnings；从非 repo-root cwd 执行。

回归 + Smoke：
11. 既有测试**语义不变**通过（JSON 快照因新增字段更新属预期，删改既有字段属违规）。
12. 本仓库真实跑 `urtext check --diff`，观察 dec: 校验与 touches 标记。

## 风险

- DECISIONS.md 标题约定成为语法面：SYNTAX.md 钉住 + 解析错误 fail-closed 缓解。
- 文件级 surface 粗粒度：内部文件改动也可能破坏公开接口，本机制只做风险**升级**信号，不做安全证明（命名已如实：touches，非 crosses）。签名级留待真实需求。
