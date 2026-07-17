# 三套脚手架使用与测试判断书（hunt / fix / audit + integrate）

> 配套阅读：specs/loops/spec.md（机制子句）、docs/checklists/（人工验收点）、
> .claude/workflows/（三套 loop 源码）、.claude/skills/integrate-worker/SKILL.md（集成协议）。
> 本文回答"怎么用、怎么测、能不能现在跑"，并诚实标注可运行边界。

## 一、背景

三套脚手架复刻自 rue-language/rue 的夜间自治体系，落在 `.claude/workflows/`：

| loop | 文件 | 职责 | 核心原语 |
|---|---|---|---|
| hunt | urtext-overnight-hunt.js | 夜间猎 bug：4 finder 并行 × 1 强模型 verify | `parallel()` / `agent()` / `Bun.$` / `gh` |
| fix | urtext-fix-cycle.js | N worker 隔离 worktree 修 bug，产 diff+meta | `parallel()` / `agent()` / `Bun.$` / `git worktree` |
| audit | urtext-spec-audit.js | 每 sprint 四透镜审 oracle 腐烂 | `parallel()` / `agent()` |
| integrate | skills/integrate-worker/SKILL.md | 7 步信任边界协议（人/主 agent 执行） | 纯协议文本，无运行时 |

机制的"承重规则"已固化为 specs/loops/spec.md 的 25 条子句，由 `urtext verify` 管辖。

**关键事实（决定"怎么用"的全部形状）**：三套 `.js` 依赖一套**外部 agent-harness 运行时**——
prelude 全局 `agent()` / `parallel()` / `read()` / `write()` / `log()`，外加 `Bun.$`、`gh`、
`git worktree`。**本仓库不提供其中任何一个**：`package.json` 依赖仅 `better-sqlite3`，
scripts 仅 `build` / `check` / `test`。因此三套 loop 是**为宿主 harness 准备的可移植 workflow 定义**，
不是本仓库可直接 `node run` 的程序。这一点必须先讲清，否则"如何使用"全是悬空。

## 二、目标

1. 明确**当前可运行 / 需宿主才可运行**的边界，杜绝"看起来能跑"的幻觉。
2. 给出三条可立即执行的验证路径（机制子句、脚本、静态检查），全部无需 harness。
3. 给出接入真实 harness 后的端到端使用与冒烟步骤。
4. 用"已知/未知"框架标注每一层的信心与折扣。

## 三、优先级

| 级别 | 事项 | 依据 |
|---|---|---|
| P0 | 机制子句常绿：`urtext verify` 对 specs/loops/ 全绿 | 机制活在文本里，文本漂移即机制失效；这是唯一已闭环的验收 |
| P0 | 验证地基先行：带 oracle 的 spec + 可追溯门禁 | 复刻指南第 1 步；三套 loop 的裁判系统，缺它 loop 是幻觉放大器 |
| P1 | hunt loop 首先接通（发现→复现→归档） | 复刻指南第 3 步：找 bug 比修 bug 易验证，先跑通管道 |
| P2 | fix + integrate 一起上（缺一不可） | 信任边界固定在集成点，worker 单独上等于无人复验 |
| P3 | audit loop 防 oracle 腐烂 | 每 sprint 兜底，非每日路径 |

优先级直接照搬复刻指南的搭建顺序：**地基 → hunt → fix+integrate → audit**，跳步使上层失效。

## 四、涉及的模块

- **脚手架本体**：`.claude/workflows/{urtext-overnight-hunt,urtext-fix-cycle,urtext-spec-audit}.js`、
  `.claude/workflows/hunt-ledger.json`（覆盖轮换台账）、`.claude/skills/integrate-worker/SKILL.md`。
- **机制裁判**：`specs/loops/spec.md`（C101–C504）、`scripts/oracle-loops.sh`（21 个 cmd 判定）、
  `docs/checklists/{hunt-run,fix-cycle-integration,sprint-audit}.md`（人工点）。
- **验证工具链**：`urtext verify`（src/cli.ts → scanner → registry → verifier → oracle-runner）。
- **外部依赖（本仓库外）**：agent-harness（提供 prelude 原语）、`bun`（`Bun.$`）、
  `gh`（issue 归档）、`git worktree`（fix 隔离）。hunt 的 AREAS 攻击面地图人工维护。

## 五、已做过的尝试（有 commit 证据）

1. `b1dd2ba` 建三套 loop + 集成协议脚手架（AREAS 从 VISION 模块推导，coverage ledger）。
2. `882ce30` 固化机制为带 oracle 的 spec + 三份 checklist（并行落地 v0 工具链自举闭环）。
3. `f920c7a` 两套子句语法统一进 `urtext verify`；cmd oracle 走 `oracle-loops.sh`，
   顺带实现 oracle-runner 的 `%20` 参数拆分（+测试）。
4. `937d0e6` / `7cebbff` 清除 Hive/Waggle 血统与移植类表述，确立全新开发叙事。

**已验证**：`urtext verify` 对 specs/loops/ 的 25 条子句 **21 cmd pass / 0 fail / 4 manual pending**
（全仓库合计 30 pass / 5 pending / manual share 14%，随 M2 新增子句浮动）；
`oracle-loops.sh` 21 项全绿；vitest 33 pass；`bun build --no-bundle` 三个 loop 语法通过。
**未验证**：任一 loop 的**端到端运行**——从未在真实 harness 上跑过 find/fix/audit 全程。

## 六、可行方案：怎么用、怎么测

### 6.1 现在就能跑（无需 harness，纯本仓库）

```bash
# A. 机制子句验收（P0，最重要）：文本在 = 机制在
urtext verify                       # specs/loops/ 的 25 条：21 cmd pass / 4 manual pending

# B. 单条机制判定（调试某条 cmd oracle 时）
sh scripts/oracle-loops.sh shell-safety && echo GREEN   # 逐个 <check> 可跑

# C. 三套 loop 静态检查（改完 workflow 先跑）
bun build .claude/workflows/urtext-overnight-hunt.js --no-bundle

# D. 全套单测 + 类型检查
npx vitest run && npx tsc --noEmit -p tsconfig.json
```

这四条是**当前唯一的"测试"**，且已全绿。它们测的是"机制文本与裁判系统一致"，
不是"loop 能自治运行"——后者需要 6.2。

### 6.2 接入真实 harness 后的端到端使用（需宿主提供 prelude 原语）

前置：一个提供 `agent()`/`parallel()`/`read()`/`write()`/`log()` 的 agent-harness（Claude Code
eval kernel 或等价物），且环境有 `bun`、`gh`（已 `gh auth login`）、`git`。

```bash
# hunt：夜间猎 bug（选最久未扫领域，find→verify→gh issue create）
<harness-run> .claude/workflows/urtext-overnight-hunt.js
#   前置：AREAS 里对应领域的模块已在 src/ 落地（否则 finder 按约定返回空）
#   产物：/tmp/urtext-hunt/<runId>/ 下的 repro；GitHub issue（label hunt,<category>）
#   台账：hunt-ledger.json 的 swept[area] 被写入当日日期

# fix：并行修 bug（需先写 .claude/workflows/fix-cycle-input.json）
echo '{"cycle":1,"clusters":[{"key":"lex","prompt":"…","issues":[12]}]}' \
  > .claude/workflows/fix-cycle-input.json
<harness-run> .claude/workflows/urtext-fix-cycle.js
#   产物：/tmp/urtext-fix/cycle-1/<key>.diff + <key>.meta；worktree 隔离
#   注意：diff 不自动合并——必须走 integrate-worker 协议

# integrate：人/主 agent 按 skill 7 步手工执行（非脚本）
#   逐项对照 docs/checklists/fix-cycle-integration.md 勾选

# audit：每 sprint 一次
<harness-run> .claude/workflows/urtext-spec-audit.js
#   产物：/tmp/urtext-audit-<date>.json（四透镜 findings，只读不建 issue）
```

### 6.3 冒烟测试策略（接 harness 后按此序，先小后大）

1. **hunt 空跑**：AREAS 指向尚未落地的模块 → 期望 finder 返回空 findings、
   不建 issue、ledger 仍更新。验证管道骨架，零 LLM 误报风险。
2. **hunt 单领域真跑**：选一个已落地模块，确认 `no repro, no report` 生效——
   无 repro 文件的 finding 应被 verify 判 refuted。
3. **fix 单 worker**：单 cluster、单 issue，确认产出 diff+meta、worktree 隔离、
   全套测试门生效；**不自动合并**。
4. **integrate 手工**：对上一步的 diff 走完 7 步，重点验证第 3 步（新 trunk 重跑 repro）
   能抓住"对过期 base 验证"的伪绿。
5. **audit 只读**：确认 agent 不改文件、不建 issue，findings 的 `ran` 字段非空。

### 6.4 无 harness 时的替代验证（degraded）

无宿主也要防 workflow 腐烂：把 `bun build --no-bundle`（6.1-C）挂进 CI；机制文本一旦
被误删，`urtext verify` 的对应 cmd 子句立即变红。即两条现成防线覆盖"文本层"回归。

## 七、修改点可能失控 / 失败的原因

按概率 × 杀伤力排序：

1. **把"文本绿"误当"机制有效"**（最高频陷阱）。`oracle-loops.sh` 是 grep 存在性检查——
   它证明规则文本在，不证明 loop 真按规则运行。有人删掉 PREAMBLE 某条规则的**行为**
   却保留**字样**，oracle 照绿。缓解：端到端冒烟（6.3）不可省；grep 判定仅是文本层第一道网。
2. **无 harness 就宣称"能用"**。三套 loop 无宿主不可运行；文档若不点破，使用者会
   `node urtext-overnight-hunt.js` 直接崩在 `agent is not defined`。本文第一节即钉死此边界。
3. **地基未建就上 loop**（复刻指南头号弯路）。当前 `specs/urtext/` 已有子句地基，
   但 hunt 的 AREAS 覆盖 9 个模块，多数尚未落地。跳过"地基先行"直接跑 hunt，
   finder 无处复现 → 全空跑或全幻觉。缓解：AREAS 领域与 src/ 落地进度对齐（sprint-audit C202）。
4. **shell 安全回归拖垮整夜**（Rue 弯路 #7）。改 workflow 时若引入 `rm $VAR/...`，
   无人值守夜跑被权限防火墙卡死。缓解：C105 已固化，改 prompt 后必跑 `oracle-loops.sh shell-safety`。
5. **worker 对过期 trunk 验证的伪绿混入主干**（Rue 弯路 #6）。fix worker 报"全绿"只对
   其 base 成立。缓解：integrate 第 3 步强制新 trunk 重跑；checklist C102/C501 是硬门。
6. **AREAS 地图腐烂**：已修 bug 未从 knownBugs 移出 → 重复上报；新模块未加领域 → 覆盖盲区。
   缓解：sprint-audit C202 人工复核，唯一防线是人。
7. **fix-cycle-input.json 手写易错**：cluster 触碰热点文件却并行派发 → double-drop 类事故
   （Rue 弯路 #5）。缓解：车道纪律 C502 + 集成第 4 步跨机制测试；但派发前的车道检查仍是人工。

## 八、已知与未知

### 8.1 已知的已知（有 git 记录 / 可复现命令）

- 机制文本与裁判一致：`urtext verify` specs/loops/ 21 cmd pass / 0 fail / 4 manual pending
  （全仓库 30 pass / 5 pending / manual 14%）。
- `oracle-loops.sh` 21 项 cmd 判定全绿；vitest 33 pass；三 loop `bun build` 语法通过。
- 三套 loop **不含**运行时，依赖外部 harness + bun/gh/git——`package.json` 与源码可证。
- integrate 是纯协议文本，无脚本；三份 checklist 承载全部人工介入点。
- 优先级顺序 = 复刻指南搭建顺序，跳步使上层失效（文档层已固化为 C1xx–C5xx）。

### 8.2 已知的未知（有明确实验设计，等数据）

- **端到端可运行性**：任一 loop 从未在真实 harness 上跑通。宿主 prelude 的 `agent()`
  返回契约、`schema` 约束的实际行为、`model:"smol"` 路由是否被宿主识别——全未验证。
  实验：先做 6.3 步骤 1（hunt 空跑），观察是否按约定返回空 findings。
- **AREAS 深度提示的有效性**：9 个领域的提示由 VISION 模块**推导**而来，非实战沉淀
  （Rue 的提示来自 30+ PR 的夜跑）。真跑前不知道哪些提示能真正制导 finder。
- **finding 误报率**：`over-capture + 强模型 verify` 的净误报率未测；verify 阶段能否
  稳定把 plausible 收敛到 confirmed/refuted 未知。
- **worktree 隔离在本仓库的实际行为**：`git worktree add` 对 `.urtext/registry.sqlite`
  （WAL 模式）并发访问是否安全，未测——并行 worker 各自 verify 可能撞 SQLite 锁。
- **manual 占比长期走势**：当前 16%（P9 门槛 <50%），但机制子句偏结构化易写 cmd oracle，
  推断不到真实业务 spec；真实仓库 loop 上线后占比可能抬升。

### 8.3 未知的未知（无法枚举，只布探测器）

| 探测器 | 监听什么 | 触发动作 |
|---|---|---|
| `urtext verify` specs/loops/ 变红 | 机制文本被误删/漂移 | CI 阻断合并，回到对应 C 子句 |
| hunt 夜跑 issue 中 refuted 占比异常高 | finder 幻觉 / AREAS 提示失效 | 暂停 hunt，人工审 AREAS 与 verify 阈值 |
| fix diff 集成时第 3 步频繁抓到伪绿 | worker 对过期 base 验证成常态 | 收紧派发前的 trunk 新鲜度检查 |
| unmapped ack 率飙升 | worker 大量改动无法归因子句 | 重审 provenance dogfood（C306）落地 |
| 无人值守夜跑频繁停在"等人类" | shell safety 或权限门有缺口 | 逐条排查 prompt 层预防（C105） |
| manual share 连续两 sprint >50% | 承重假设塌方（VISION P9） | 停止扩建 loop，不允许加功能挽救 |

最后一道防线是文化性的：**三套 loop 的每条承重规则都必须以子句形式活在 specs/loops/ 里**。
当某个"未知的未知"击中机制时，它必然表现为某条 C 子句无法再绿、或没有子句能描述它——
那一刻它就自动变成"已知的未知"。这是机制对自身认知边界的 oracle。
