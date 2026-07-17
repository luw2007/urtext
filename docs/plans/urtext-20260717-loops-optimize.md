# 规划：针对当前仓库优化三套脚手架

> 计划文件：docs/plans/urtext-20260717-loops-optimize.md
> 配套：docs/BRIEF-loops.md（使用/测试判断书）、specs/loops/spec.md（机制子句）、
> .claude/workflows/（三套 loop）、.claude/skills/integrate-worker/SKILL.md。
> 范围：仅优化已存在的三套脚手架 + 集成协议，使其贴合**当前**仓库状态。
> **非目标**：不实现 agent-harness 运行时、不改 M2–M4 业务模块、不新增 loop 种类。

## 一、为什么现在要优化（问题诊断）

三套脚手架落地于早期（commit `b1dd2ba`），此后仓库快速长出 M2/M3/M4 模块。
脚手架与仓库现状已出现**五处失配**，每处都有证据：

| # | 失配 | 证据 | 影响 |
|---|---|---|---|
| D1 | hunt 的 AREAS 攻击面地图停在早期 | AREAS 9 领域仍以 evidence-store/dwarf-mapping 等"未来态"命名，但 `src/` 已落地 `linker.ts`/`dwarf.ts`/`gate.ts`/`review.ts`/`decision.ts`/`audit.ts` + 对应测试 | finder 攻击面与真实代码错位；已落地模块无人扫，未落地领域空跑 |
| D2 | knownBugs 全空、无覆盖轮换记录 | 9 领域 `knownBugs: []`，`hunt-ledger.json` 为 `{"swept":{}}` | 无排除项 → 重复上报；无轮换基线 |
| D3 | 可运行的文本层检查未接 CI | 无 `.github/`；`urtext verify`/`oracle-loops.sh`/`bun build` 全靠人跑 | 机制文本被误删/漂移无守卫（BRIEF-loops 失败原因 #1） |
| D4 | loop 里"全套测试"未命名、命令不对齐 | fix.js:122 `Run the full test suite`、PREAMBLE 第 3 条泛指；仓库实际是 `npx vitest run` + `npx tsc --noEmit` | worker/集成者不知道跑什么 = 空口验收 |
| D5 | 无 harness 冒烟入口 | 三套 loop 依赖外部 prelude 原语，仓库无最小驱动或 dry-run 开关 | 端到端从未跑通（BRIEF-loops 已知的未知 #1）；无法渐进验证 |

补充隐患（非阻塞，纳入观察）：
- D6 fix worker 并行 verify 撞 `.urtext/registry.sqlite`（WAL）锁——未测（BRIEF-loops 已知的未知）。
- D7 `ERROR_CODE_BLOCK` 预留 `UX-1000..` 错误码，但仓库当前错误码是 `missing_oracle` 等**字符串枚举**（clause-parser.ts / registry.ts），无数字段——预留区间对不上真实命名空间。

## 二、目标（可验收）

1. AREAS 地图与 `src/` 落地模块一一对齐；每个已落地领域至少 1 条深度提示引用真实符号。
2. 文本层三项检查（verify / oracle-loops / bun build）进 CI，任一红即阻断。
3. 三套 loop 内的"全套测试"统一为仓库真实命令，并抽为单一事实源常量。
4. 提供 harness 无关的 hunt **dry-run 冒烟**路径，端到端骨架至少跑通"空 findings"。
5. 机制子句随上述改动同步（新增/修订 C 子句 + oracle），`urtext verify` 保持全绿。
6. D6/D7 各产出一条结论（修复或显式 ack 落决策记录），不留悬空。

## 三、优先级与阶段（每阶段独立可合、独立有值）

严格按依赖排序；跳步使上层落空。

### P0 · 阶段 A：文本层守卫上线（先保住已绿的东西）
最高优先——当前一切"已验证"都靠人跑，最脆弱。
- A1 新增 `.github/workflows/ci.yml`：`npm ci` → `npx tsc --noEmit` → `npx vitest run`
  → `npx tsx src/cli.ts verify` → `for c in $(所有 check); do sh scripts/oracle-loops.sh $c; done`。
- A2 抽仓库真实测试命令为单一常量：新增 `scripts/full-test.sh`（`npx vitest run && npx tsc --noEmit -p tsconfig.json`），
  CI 与 loop 都引用它，消除 D4 的口径漂移。
- **验收**：CI 在 PR 上运行并对"删除某条 PREAMBLE 规则文本"的负向改动变红。

### P1 · 阶段 B：hunt 贴合当前仓库（AREAS/ledger/命令对齐）
- B1 重写 AREAS：领域集合改为映射真实模块——
  `clause-parser`/`oracle-exec` 保留并补符号级提示；
  新增/改名 `linker`(linker.ts)、`dwarf`(dwarf.ts)、`risk-gate`(gate.ts)、`meta-review`(review.ts)、
  `decision-log`(decision.ts)、`spec-audit`(audit.ts)、`registry`(registry.ts)、`cli-git`(cli.ts)；
  移除仍属"未来态"且无代码的领域（或标注 `landed:false` 由 finder 跳过）。
- B2 `hunt-ledger.json` 增 `landed` 白名单或让 hunt 读 `src/` 存在性，未落地领域不进轮换。
- B3 finder/verify 里"full test suite"引用 `scripts/full-test.sh`（承接 A2）。
- B4 knownBugs 接线：从 `gh issue list --label hunt --state open` 动态注入排除项（去掉硬编码空数组的死结构）。
- **验收**：`bun build --no-bundle` 通过；AREAS 每个 `landed:true` 领域的提示 grep 得到 `src/` 真实符号；
  新增 C 子句 `hunt.areas-aligned` 绿。

### P1 · 阶段 C：fix + integrate 对齐当前仓库
- C1 PREAMBLE 第 3 条与 fix.js:122 统一走 `scripts/full-test.sh`（承接 A2）。
- C2 D7 结论：把"reserved error-code range"改为**本仓库真实的预留命名空间**——
  clause id 前缀（`C9xx` 段）或 fixture 目录编号；若判定当前无并行分配冲突风险，则显式删除该规则并在
  decisions 落 ack（不留对不上的规则）。
- C3 集成 checklist 的"全套测试"列同步 `scripts/full-test.sh`。
- **验收**：`oracle-loops.sh reproduce-first`/`coverage-follows-capability` 仍绿；C304 子句按 C2 结论更新后 verify 绿。

### P2 · 阶段 D：harness 无关冒烟入口
- D1 给三套 loop 加 `DRY_RUN` 短路：置位时 `agent()` 被一个返回 `{findings:[]}` / 空 meta 的桩替代
  （仅骨架路径：领域选取、ledger 写入、目录创建、schema 形状），不调真实模型、不建 issue、不 `git worktree`。
  桩由环境变量选择，默认关闭——生产路径零改动。
- D2 新增 `scripts/loops-smoke.sh`：在 DRY_RUN 下依次跑三套 loop，断言退出码 0、ledger 被更新、
  产物目录结构符合预期。挂进 CI（承接 A1）。
- **验收**：`sh scripts/loops-smoke.sh` 绿；证明 BRIEF-loops「已知的未知 #1」端到端骨架可跑通空态。

### P2 · 阶段 E：D6 并发结论
- E1 写一个最小并发测试：两个进程各自对同一 `.urtext/registry.sqlite` 跑 `verify`，观察 WAL 锁行为。
- E2 结论二选一：确认 WAL 下只读 verify 安全 → 落决策记录；或发现写证据竞争 → 记为 hunt known bug + issue。
- **验收**：结论落 `docs/DECISIONS.md` 或对应 issue，BRIEF-loops「worktree 隔离」条目从"未测"转为有据。

## 四、涉及的修改点（文件级）

| 文件 | 阶段 | 改动 |
|---|---|---|
| `.github/workflows/ci.yml`（新） | A | 文本层 + 测试 + 冒烟全接 CI |
| `scripts/full-test.sh`（新） | A | 仓库真实测试命令单一事实源 |
| `.claude/workflows/urtext-overnight-hunt.js` | B | AREAS 重写、landed 过滤、knownBugs 动态注入、full-test 引用 |
| `.claude/workflows/hunt-ledger.json` | B | landed 白名单 / 结构调整 |
| `.claude/workflows/urtext-fix-cycle.js` | C | full-test 引用、错误码预留区间按 D7 结论修正 |
| `.claude/skills/integrate-worker/SKILL.md` | C | 全套测试列对齐 full-test |
| 三套 `*.js` | D | DRY_RUN 短路桩 |
| `scripts/loops-smoke.sh`（新） | D | 冒烟脚本 |
| `specs/loops/spec.md` + `scripts/oracle-loops.sh` | B/C/D | 新增/修订 C 子句及其 cmd 判定，保持 verify 全绿 |
| `docs/DECISIONS.md` | C/E | D7 错误码、D6 并发的结论落档 |
| `docs/checklists/*` | B/C | 机器门从人跑改为"CI 绿"，命令对齐 |
| `docs/BRIEF-loops.md` | 收尾 | 把兑现的"已知的未知"上移为"已知的已知" |

## 五、可能失控 / 失败的原因

按概率 × 杀伤排序：

1. **改 AREAS 时把"文本绿"当"攻击有效"**（BRIEF-loops 失败原因 #1 的具体化）。
   B1 让提示 grep 到真实符号只保证"提示不空谈"，不保证 finder 真能据此找到 bug——
   真有效性只有 harness 真跑才知道。缓解：D 阶段冒烟先行，B 的验收明确只声称"对齐"，不声称"有效"。
2. **DRY_RUN 桩污染生产路径**。若短路逻辑写进主流程而非边界注入，可能改变真实运行行为。
   缓解：桩仅在环境变量置位时替换 `agent()` 入口，生产路径 diff 为零；冒烟脚本本身验证这一点。
3. **CI 把慢测试拖成瓶颈**。vitest 曾观测到单次 ~28s（含 oracle 真跑子进程）。缓解：CI 分 job 并行；
   oracle-loops 的 21 项是纯 grep，与重测试分离。
4. **AREAS 领域改名冲断 ledger 历史**。swept 键随领域 id 变化会丢轮换记录。缓解：B2 做一次 id 迁移映射，
   保留旧键或显式重置并注明。
5. **错误码预留区间"修正"变成过度设计**（D7）。若强行发明一套数字错误码去匹配规则，是为规则造需求。
   缓解：C2 默认倾向**删规则 + ack**，只有确有并行分配冲突才保留。
6. **子句同步遗漏使 verify 变红却无人察觉**。缓解：A 阶段 CI 先上，之后每阶段改动都被 verify 门拦住。

## 六、已知与未知

### 6.1 已知的已知（有证据）
- 仓库已落地 linker/dwarf/gate/review/decision/audit 六模块 + 测试（glob 可证），AREAS 未同步。
- 文本层三检查当前全绿但无 CID 守卫（无 `.github/`）。
- loop 内"full test suite"与仓库真实命令（vitest+tsc）口径不一致。
- 错误码预留区间（数字 UX-1xxx）与仓库真实错误命名（字符串枚举）对不上。

### 6.2 已知的未知（本规划要回答）
- DRY_RUN 骨架能否跑通空态（阶段 D 回答）。
- WAL 下并行 verify 是否安全（阶段 E 回答）。
- AREAS 对齐后，提示能否真正制导 finder——**仍不由本规划回答**，需 harness 真跑，显式留给后续。

### 6.3 未知的未知（布探测器，不预测）
| 探测器 | 监听 | 触发 |
|---|---|---|
| CI 中 verify specs/loops 变红 | 机制文本漂移 | 阻断合并，回对应 C 子句 |
| 冒烟脚本退出码非 0 | loop 骨架回归 | 阻断，定位短路桩或产物路径 |
| ledger swept 键出现未知领域 | AREAS 与 src 再次错位 | sprint-audit C202 人工复核 |

## 七、执行顺序回执

A（CI+full-test）→ B（hunt 对齐）→ C（fix/integrate 对齐）→ D（冒烟）→ E（并发结论）→ 收尾（BRIEF/子句同步）。
每阶段结束跑 `scripts/full-test.sh` + `urtext verify` 全绿方可进入下一阶段；A 阶段一旦合入，
后续阶段自动被 CI 守卫。每阶段一个逻辑单元，完成即 commit。
