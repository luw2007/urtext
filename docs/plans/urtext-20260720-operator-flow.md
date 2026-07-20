# 规划：操作流程重设计——人只做判断（operator flow）v3

> 计划文件：docs/plans/urtext-20260720-operator-flow.md
> 配套源：docs/BRIEF.md（赌注）、VISION.md（P1–P9）、DECISIONS.md（D3/D4/D6/D10）、
> ROADMAP.md（里程碑规则与种子门槛）、docs/wiki/guides/（现行操作叙事）、
> src/cli.ts（13 命令现状）、src/gate.ts、src/review.ts、src/decision.ts、src/audit.ts。
> **v3 合并**：吸收 docs/plans/urtext-20260717-review-ui.md 的后续演进——该方案四个
> Phase 已全部交付（HEAD d8c208b、实验版已删、oracle-wiki 含 ui、C006 已裁决），
> 本计划把 `urtext ui` 从"manual 裁决面板"升级为**操作台**：双车道 status 视图 +
> 简报内联（服务端复用 brief 文本渲染）+ decide 携带 brief-hash（domain 守卫统一
> 校验）。高危代码审查保持 CLI-only（review-ui 方案的既定非目标：代码是唯一可
> review 的事实，面板上无码不批）。
> 范围：**单 checkout 交互式场景**下人-agent-urtext 三方操作流程 + 最小命令面。
> worktree 并行 worker 的交接由 integrate-worker 协议管辖（D10），不在本计划内。
> **非目标**：urtext 不调用任何 LLM；不做 watch/TUI/团队协作；不新增 oracle 种类；
> 不改 M5a 的 HEAD 绑定语义（见 v2 修订记录）。
> 审查记录：v1 经 codex 对抗式审查（2026-07-20，36 条发现 / 9 blocker，verdict rework），
> v2 为裁决采纳后的重写；裁决明细见文末修订记录。

## 一、为什么要重设计（问题诊断）

BRIEF.md:23 的生存赌注：**写 oracle 的成本 < 逐行审代码的成本**。人被迫花掉的每一
分钟都计入成本侧。对 14 个人工触点的盘点显示，人的时间被三类消耗瓜分，其中两类
不该由人承担：

| # | 消耗 | 证据 | 定性 |
|---|---|---|---|
| 1 | 判断：high-risk 审查、manual 裁决、audit 分歧、unmapped 归属 | 四大触点，ROADMAP.md:47 | 该花——设计目标本身 |
| 2 | 装配：gate 只给理由索引不给内容；review 零上下文，人自己翻 spec+代码+sqlite | src/gate.ts:130-164 只产理由串；unsafe-lane.md:15 "The human must look at the code"；registry 除 `decisions` 外无查询命令 | 不该花——registry 已存 clause 修订、code map、evidence、audit、decision 各构件，缺的是 revision-safe 的关联呈现层（注意：构件间尚无严格外键闭环，见四.2 manifest 设计） |
| 3 | 劳役：audit 人肉捕获 JSON、手糊 verdicts 文件；PR 模板三节手填；clause 语法零脚手架 | src/cli.ts:166-196；pull-request-gates.yml；无 `init/new` 命令 | 不该花——纯机械 |

叠加风险：负载上升时人的审查会退化（Habituation at the Gate，arXiv:2606.22721：
批准率 +14.5pp、inline 评论 -22%）。流程必须既削掉 2/3 类消耗，又防止把第 1 类
"顺滑"成盖章。

## 二、设计原则

1. **人只做判断**：装配归 urtext（确定性关联呈现），起草归 agent（经 `--json` 缝
   消费），人只在意图批准与裁决两处出现。
2. **单入口**：人的会话从一个队列开始；队列按 owner 分道——agent 可自行修复的项
   （缺证据、oracle 失败、未审计）不进人的车道，人默认只看前置已满足的裁决项。
3. **简报先行，fail-closed**：high-risk 裁决必须携带与当前内容匹配的简报哈希。
   该机制保证的是**新鲜度**（批准所引用的即当前内容），不宣称证明阅读或理解。
4. **不削弱既有安全语义**：高风险批准继续绑定完整 HEAD（M5a 不动）。DWARF 映射的
   diff 相交校验只是弱溯源（证明与真实 hunk 至少一行重叠，不证明语义相关，
   src/dwarf.ts:151），**映射用于导航，不作安全边界**。

## 三、目标操作流程（一次变更循环，单 checkout）

### 阶段 0 意图（人 + agent）
agent 依据人的散文意图起草 clause + oracle（VISION.md:73 教义：AI 起草，人批准），
人改批草稿；`urtext check` 绿。（脚手架命令列为候选，见六.P3）

### 阶段 1 实现（agent 独占，人缺席）
agent 交付纪律（写入 loops 协议文档，不设 manual gate 子句——理由见修订记录 R4）：
- `check` 绿；`verify` 已跑；
- 实现中直接执行 `urtext map`/`ack`（D4 交集校验适用；map 无草稿态，cli.ts:292
  即时入库——agent 的映射操作与人共库，经 status/brief 可见、经 gate 受检）；
- 无法归属的 hunk：起草补救命令（map/ack/spec 回写）附在交付说明中，由人裁决后执行；
- audit 轮完成：`audit --export`（已是 JSON）→ 异构 preset 审计 → `audit --import`。

### 阶段 2 收敛（人，1 条命令）
`urtext status`：与 gate/audit 相同的 scan-reconcile 前置（会追加 clause 修订并
传播 stale——与现有命令同构；**绝不执行 oracle、不写 evidence/decision**），然后
输出双车道队列：
- **agent 车道**：缺证据、oracle 失败、stale 待重跑、未审计——附可直接交给 agent
  的补救动作；
- **人车道**：前置已满足的裁决项——pending high-risk review、pending manual
  decision、audit 分歧、待裁决 unmapped。

队列以 **item 为键**（一个 clause 只出现一次，主阻塞 + 次要原因列表，非六类原因
平铺），按（阻塞性 > 风险）排序。`--wip-limit <n>`（默认 10，**临时值**，P1/P2
落地后按真实队列数据校准）超限告警。

### 阶段 3 裁决（人的唯一主战场）
逐项 `urtext brief <spec>#<clause>`（或 `<file>:<range>`）：一屏输出条文全量
（title/body/oracle/risk/refs）+ 映射 hunks + 最新证据摘录（对齐 verify 的
前 6 行语义，`--lines n` 可调）+ audit verdict + **影响闭包**（refs 反向闭包与
stale 依赖，VISION 要求的人审范围）+ 历史 decisions/reviews，末行给出 `brief-hash`。
随后裁决：
- `urtext review <spec>#<clause> --approve --brief <hash>`（要求 clean worktree，
  否则 fail-closed——语义见四.3）
- `urtext decide <spec>#<clause> --pass --brief <hash>`（risk:high 的 manual 强制）
- 执行 agent 起草的 map/ack/spec 回写。

### 阶段 4 合并（人，1 条命令）
`urtext gate --diff` 绿（必须带 `--diff`，否则 unmapped 不计入，cli.ts gate 分支）。
PR 装配自动化列为候选（六.P3）。

### 步数对比（含 2 unmapped、1 high-risk、1 manual 的典型变更）

| | 旧流程 | 新流程 |
|---|---|---|
| 人工步骤 | ≈11 步：check、check --diff、blame×2、手写 map/ack×2、verify、audit 捕获+手糊 verdicts、gate 平铺清单、翻 spec+代码后 review、decide、手填 PR | ≈6 步：status、brief+review、brief+decide、残留 unmapped 每项一次批准执行、gate --diff、PR（仍手填，自动化为候选） |
| 其中装配/劳役 | ≈7 步 | ≈1 步（PR 手填） |

基线纪律：P1 上线前后各记录一次真实 operator 动作数与耗时，上表估算以实测替换；
P3 候选是否启动由该数据决定。

## 四、启用改动（首轮只做三件事）

| # | 改动 | 实质 | 验收 |
|---|---|---|---|
| 1 | `urtext status [--json] [--wip-limit n]` | scan-reconcile + 聚合读（不执行 oracle、不写 evidence/decision）；item 键控、owner 双车道、主阻塞+次因 | 双车道齐全；一 clause 一 item；C016 |
| 2 | `urtext brief <ref> [--json]` | 按 **manifest v1** 装配：条文全量行（title/body/oracle/risk/refs——text_hash 只含 title+body，registry.ts:140，故 manifest 必须显式纳入 oracle/risk/refs）+ 映射 hunk 内容 + 最新证据摘要（**digest = verdict ∥ output hash ∥ oracle_ref**，非自增 evidence_id，等结果重跑不换哈希）+ audit 状态 + 影响闭包；`brief-hash = hash(manifest)`。**ready-guard**：revision 处于 building/link-error 时拒发可批准哈希 | 单命令产出全部上下文；C017 |
| 3 | 批准前置强化（不改绑定语义） | HEAD 绑定保持（M5a/C013 原样）。新增两个 fail-closed 前置：risk:high 的 approve/decide 必须携带与当前重算一致的 `--brief <hash>`（不符即 `brief_required`/`brief_stale`）；且要求 **clean worktree**——批准后的未提交编辑要么弄脏树（gate 对 high-risk 标记 dirty）要么成为新 commit（HEAD 移动，既有失效语义接管），unsafe-lane.md:32 陷阱由此闭合。**守卫落在 domain 写路径**（recordReview/recordDecision），`urtext ui` 与 CLI 同路径受检（review-ui.ts:7 已声明同路径纪律） | 无有效 hash / 脏树的批准必败；UI 无法绕过；C018 |

`--json` 合同：版本化 envelope（`{schema: "urtext.status/1", ...}`）、typed reason
枚举（非自由字符串）、非零退出仍输出合法 JSON、schema fixture 锁定。

## 五、自举验收（新增子句；C015 已被 wiki 覆盖子句占用，从 C016 起）

```markdown
## C016 status 双车道队列完整且 item 键控 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C012 -->
任一待办存在时必入队且仅入队一次（主阻塞+次因）；agent 可自愈项不入人车道。

## C017 brief 单命令产出完整裁决上下文 <!-- oracle:test:tests/brief.test.ts refs:specs/urtext/spec.md#C009 -->
对任一路由到人的 clause，brief 含条文全量、映射 hunks、证据 digest 摘要、
影响闭包与 brief-hash；building/link-error 修订拒发哈希。

## C018 high-risk 批准的新鲜度与洁净前置 <!-- oracle:test:tests/brief-gate.test.ts risk:high refs:specs/urtext/spec.md#C013 -->
无有效 brief-hash 或 worktree 不洁净的 review --approve / 高危 decide 必须
fail-closed；守卫在 domain 写路径，CLI 与 ui 同受检。
```

同变更义务（每阶段验收内置，不后补）：C006 命令集人工确认、oracle-wiki.sh
command-coverage 同步（既有 C015）、tasks.md 绑定、EN/zh 文档与 wiki 命令参考更新。
负面测试矩阵随实现落：anchor-only 变更、等结果重跑、audit 翻转、多映射区间、
同文件无关 hunk、commit/rebase 后重算、UI 绕过尝试、JSON 错误路径。

## 六、分阶段交付（每阶段独立可合并，遵守 ROADMAP 规则）

1. **P1 看见**：status + `--json` envelope（status/gate/check --diff 三处）。
   验收：C016 + 同变更义务；record 操作基线。
2. **P2 判断**：brief（manifest v1 + ready-guard + 影响闭包）+ 批准前置强化
   （brief-hash + clean worktree，domain 层守卫）+ **UI 操作台**（双车道视图、
   /brief 简报页复用 CLI 文本渲染、decide 经 /api/brief 取 hash 后提交——与
   CLI 走同一 recordDecision 守卫）。验收：C017/C018 + 同变更义务。
3. **P3 候选（不承诺，摩擦数据触发）**：`new <feature>` 脚手架、`report --pr`
   （仅承诺生成 body 草稿，接收 `--issue`；labels 与 checkbox 属外部动作，
   pull-request-gates.yml 的通过不由 CLI 单方保证）、`audit --template`
   （仅列 live、non-stale、unaudited 证据）。启动条件：P1/P2 基线数据显示对应
   劳役仍是 top 摩擦。
4. **P4 理解层（重定义，零新 CLI 面）**：对 Litt《Understanding is the new
   bottleneck》的回应保持——理解层是裁决承诺的补全——但交付形态改为
   **`brief --json` 基座 + agent 层 explainer skill**（Litt 本人的 `/explain-diff`
   即此形态）：叙事编排、前后心智模型、自查问题由 agent 生成，事实层每条可溯源到
   brief manifest。urtext 不新增 explain 命令。

## 七、风险与边界

- **盖章化风险**：brief 一键生成，approve 不一键——`--brief <hash>` + clean
  worktree 强制批准引用当前内容；`--wip-limit` 提示拆小。哈希机制不宣称证明
  阅读或理解（agent 也能算哈希），它保证的是新鲜度与内容一致性。
- **确定性边界**：urtext 全程零 LLM 调用；起草物经 `--json` 在 agent 层流转。
  精确表述：**explain/brief 的叙事层不入 registry**；audit verdict 是模型判断
  入库的**有意例外**（D3 的设计本体，audit.ts:175）。
- **quiz 不进放行条件**：理解不可机械判定，伪装成合规动作会破坏 P2；LLM 评分
  破坏零 LLM 边界。失败模式陈述不设强制子句（只能验非空，正是 Goodhart 合规
  动作）；`--note` 保持自愿，写入既有 ledger 字段。quiz 题目可由 agent 层
  explainer 生成供自查——Litt 的原始用法本就是自律规则，不是门禁。
- **micro-world 不建运行时**：oracle 即微世界——brief 附复现命令与映射入口，
  "改一行看它变红"是 git-native 的可操作环境。
- **共享空间不拥有**：身份/同步/评论不增强 oracle 可信度；导出物进现有协作面。
- **理解债指标防 Goodhart**：只测机械可测的（brief 覆盖率），不测"理解率/quiz
  通过率"。要跟踪就写成 clause。
- **异构审计边界如实陈述**：audit --import 只验 evidence id，异构 preset 是操作
  纪律而非机制保证（command-reference.md:76）——status/brief 只报告"已有 imported
  verdict"，不宣称异构已被验证。
- **止损条件对齐**：若 P1/P2 上线后 design partner 仍反馈"裁决比逐行审代码还贵"，
  按 ROADMAP.md:66 停止扩张。

## 修订记录（v1 → v2，codex 审查裁决）

- R1 **采纳（blocker）**：放弃"内容哈希替代 HEAD 绑定"。映射是弱溯源不可作安全
  边界；高危批准保持 HEAD 绑定，brief-hash 降为新鲜度前置 + clean worktree 要求。
  连带消除 schema 迁移、legacy cutoff、批准复活等一族 blocker。
- R2 **采纳（blocker）**：brief-hash preimage 由"text_hash∥hunks∥evidence_id"改为
  versioned manifest（含 oracle/risk/refs 与 evidence digest）；增设 ready-guard；
  守卫下沉 domain 写路径覆盖 UI。
- R3 **采纳（blocker）**：C015 编号冲突改从 C016 起；同变更义务（C006/wiki oracle/
  双语文档）写入每阶段验收；阶段 4 改用 `gate --diff`。
- R4 **采纳（major）**：砍 explain 命令（P4 重定义为 brief --json + agent skill）、
  砍 C019 manual 协议子句（每 commit 重 pending、抬高 manual share）、砍 C021
  强制非空 note（Goodhart）；P3 全部降为数据触发的候选；status 增加 owner 双车道
  与 item 键控；"纯读"更正为 scan-reconcile 语义；`audit --export --json` 伪 flag、
  "证据尾部"误引 cli.ts:462（实为前 6 行）等事实错误订正。
- R5 **部分采纳**：WIP 阈值保留为可配 flag（CLAUDE 纪律：阈值必须可配），默认值
  标注为临时、待数据校准；codex 建议的"完全砍掉"未采纳。
- R6 **未采纳**："理解层整体无价值"不成立——codex 只评了工程面；Litt 响应以
  P4 新形态保留，护城河论证（事实可溯源 vs 通用 LLM 复述）不变。
- R7 **v3 合并（用户指示）**：与 urtext-20260717-review-ui.md 合并实施。该方案已
  全部落地，合并点为 UI 操作台化（P2 内交付）；高危代码审查保持 CLI-only，
  brief 渲染 CLI/UI 共用一个文本渲染器（单一事实源，C104 纪律）。
