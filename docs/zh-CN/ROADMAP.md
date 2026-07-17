# 路线图（每期独立可合、独立有值）

> 规则：任何一期结束系统处于可用状态；下一期永不作为上一期的前提被"预支"。
> 每期验收 = 该期新增子句在 `specs/urtext/` 中全绿。

## M1 验证器（已完成 ✅）

clause/checklist 语法、不可变修订链注册表、oracle runner
（test/cmd/diff-scope/manual）、append-only 证据、`index/check/verify` CLI、
自举 feature 单元。

验收（已达成）：`urtext verify` 对本仓库 5 pass / 1 pending manual / exit 0；
负向路径（无 oracle 子句、失败 oracle）分别 exit 1。

## M2 Linker：影响分析（已完成 ✅）

- `refs` 建子句引用图（`clause_refs` 表，随修订链版本化），跨文件解析，
  `unknown_ref` fail-closed（check 阶段全量校验，捕获目标被删的悬空引用）。
- 子句 text_hash 变更 → stale 沿反向闭包传播；stale 子句证据打 `invalidated_at` 作废。
- `urtext impact <spec-path>#<clause-id>`：机械输出受影响子句/任务清单。

验收（已达成）：C007/C008 绑定 tests/linker.test.ts 全绿；自举单元
（specs/urtext/）8 条子句 7 pass / 1 pending manual / exit 0。

独立价值：改一条 spec 能回答"波及什么"——现有一切 SDD 工具都做不到。

## M3 DWARF：clause↔code↔evidence（已完成 ✅）

- `clause_code_map` 落库（`map` 写映射、`ack` 显式豁免），声称范围用**当时真实
  `git diff` 交叉验证**方落库（provenance 信 diff 不信 LLM 自述，见 DECISIONS D4）。
- `urtext blame <file>:<line>`：反查代码行由哪条子句约束。
- unmapped change 检测进入 `urtext check --diff`：无法归因到映射/ack/spec 回写的
  hunk 退出码 1。

验收（已达成）：C009/C010 绑定 tests/dwarf.test.ts 全绿；自举单元 10 子句
9 pass / 1 pending manual / exit 0。

独立价值：事实源翻转开始执法；失败归因到子句。

## M4 元验证 + 自动通过（已完成 ✅）

- 跨模型证据覆盖审计：`audit --export` 导出已判定证据的覆盖包，异源 preset agent
  逐 evidence 判 agree/disagree，`audit --import` 回灌（verdict 绑定 evidence_id，
  只读证据不重跑，DECISIONS D3）。
- 风险分级裁决门 `urtext gate`：`low + evidence=pass + audit=agree + 非 stale`
  自动通过；high/失败/pending/disagree/unaudited/stale/unmapped 任一 → 人工附原因。

验收（已达成）：C011/C012 绑定 tests/gate.test.ts 全绿；自举单元 12 子句
11 pass / 1 pending manual / exit 0。

独立价值：人工量收敛到高危与分歧。

## M5a unsafe lane（已完成 ✅）

- `risk:high` 子句强制人工代码级审查工作流：`urtext review --approve|--reject`
  记录人工裁决，绑定当时 HEAD sha（HEAD 变更即失效须重审）；gate 据此放行或
  阻断高危子句。证据全绿也不自动通过——代码是唯一可 review 的事实（VISION P5）。
  审查记录持久落库（Decision ledger 种子）。

验收（已达成）：C013 绑定 tests/review.test.ts 全绿；自举单元 13 子句
12 pass / 1 pending manual / exit 0。

独立价值：高危路径不再死锁，人工审查进入可追溯工作流。

## M6 记忆层：Decision ledger（已完成 ✅）

- manual oracle 子句永远 pending（无可运行 oracle 判定），此前在 gate 里死锁；
  `urtext decide --pass|--fail` 记录人工裁决，绑定当时 HEAD sha（HEAD 变更即失效），
  持久落 `decisions` 表（DESIGN §7）。仅 manual 子句可裁决——runnable oracle 由
  客观证据判定，守 P2。`urtext decisions` 查询 Decision ledger。
- gate 接入：manual 子句见当前 HEAD 的 pass Decision 即放行；manual 子句不参与
  跨模型 meta-audit（人工裁决即 ground truth，D3 的 audit 只审 runnable 证据覆盖）。

验收（已达成）：C014 绑定 tests/decision.test.ts 全绿；自举单元 14 子句全部可判定。

独立价值：VISION P4「人工裁决落决策记录」闭环；四类人工触点（unmapped-ack、
meta-audit disagree、high-risk review、manual decide）全部有持久 Decision 落库。

## M5b 多模态 oracle（v1，按 SYNTAX v0 边界推迟）

- visual（截图 diff 对设计稿）/ interaction（demo 回放）oracle kind。
- 需截图 diff / demo 回放运行时；与 P8 serverless 边界冲突，留待 v1 扩展
  `oracle` kind 与 `refs` 目标类型，不改既有语法（SYNTAX.md v0 边界已声明）。

## 种子验证策略（贯穿 M2-M4）

- 找 **10 个 design partner**：日常使用 Claude Code/Codex、AI 代码占比高的
  个人开发者或 2-5 人团队；亲自辅助完成首次接入。
- 通过标准：
  - ≥7 人在 10 分钟内为真实 feature 写出第一条带 oracle 的子句并跑通 verify；
  - 第二周 ≥4 人不经提醒主动运行 ≥3 次；
  - manual oracle 占比中位数 <50%（承重假设成立，VISION P9）；
  - ≥3 人明确愿为稳定版付费。
- 停止条件：
  - 用户反馈集中在"写 oracle 比 review 代码还贵" → 假设失败，停止扩建，
    不允许靠加功能挽救；
  - manual 占比持续 >50% → 同上；
  - 用户认为 spec-kit/CodeRabbit 已足够 → 差异不成立，重新判断赛道。
