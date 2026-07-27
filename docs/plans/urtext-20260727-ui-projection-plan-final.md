# Urtext UI Human-Projection — 最终裁决方案(round 3 owner synthesis)

> 构建契约。冲突时:本文件 > 攻击文档 fix > Plan A(opus)> Plan B(codex)。
> Plans: docs/plans/urtext-20260727-ui-projection-plan-{opus,codex}.md
> Attacks: .urtext/attack3-on-opus.md(Codex 攻 A,BL-1..4/MJ-1..6/MN-1 + 43 行记分卡)、.urtext/attack3-on-codex.md(Opus 攻 B,BL-1..5/MJ-1..5)
> Brief: .urtext/ui-projection-brief.md(pinned contract 有两处由 owner 显式改约,见裁决 0a/0b)

## 裁决 0:owner 改约(对 pinned contract 的两处显式修订)

- **0a(原 pinned 6)**:UI dogfood 子句编号 **C027 → C028**——sibling verify-perf lane 已合法占用 C027(commit c53764e)。任何"再写一个 C027"的路径都是 duplicate_clause_id 硬失败(攻击双方一致)。
- **0b(双方共同盲区,两侧攻击均列为 blocker)**:P1 两列 stamp 必须**spec 回写 C008**——"invalidated_at——证据唯一可变列"改为"作废戳(invalidated_at + invalidation_source)同一事件写入——证据唯一可变面,作废不删除(审计保留)"。同步修 src/verifier.ts:31 注释。**预算级联**:C008 text_hash 变 → C022(refs C008)证据作废 → 迁移提交后 re-verify + 定向 re-audit + C008/C022(均 high)re-review。C008 的 oracle(tests/linker.test.ts)同步扩两列断言。

## 裁决总表(43 争点收敛为 24 条)

| # | 争点 | 裁决 | 采纳 |
|---|---|---|---|
| 1 | evidence 迁移 | A §1.1:DDL 在 `input_fingerprint` 之后追加 `invalidation_source TEXT`,ensureEvidenceLedger 加第 4 条幂等 ALTER,**不加** transaction wrapper(scanner 已有外层事务) | A(s1/s2) |
| 2 | stale 归因遍历 | A 的 labelled BFS(stale set 与 source 同构,key-only 是 wrapper);**反事实因果语义**:FR 命中的子句归因于 FR,其 refs 下游归因于该子句自身(没有 FR 变化下游也会因 C 变而 stale);多根 tie 按 seed 顺序 first-writer;legacy NULL 不回填,渲染"上游变更 → 证据作废" | A(s5/6/7/8) |
| 3 | 因果句 | 组装在 `render-console.ts`(进双 hash);句尾用 A 的"重跑 verify 前不放行"(恒真;"需重审"不恒真);i18n 跟随现有中文文案面 | A(s9/10) |
| 4 | source 进 brief manifest | B:manifest 增 optional `invalidationSource` 字段并入 brief-hash——P4 的解释要能溯源肇事者 | B(s11) |
| 5 | P2 聚合位置 | renderer 内从 raw UiClause 聚合(在双 hash 内,fixture 无法绕过聚合逻辑);**不进** status JSON | A(s12/13/38) |
| 6 | P2 健康有效性 | B:stale 的 pass 不计健康分子;dirty-worktree 下的 approval 不计已审——阻断项存在时不得假绿 | B(s14,MJ-1) |
| 7 | P2 markup/位置/零分母 | `<ul>`(one-table-per-route 硬断言);置于 fail-closed alert 之后、queue 之前;零分母显示 `n/a (0/0)` | A(s15/16)+B(s17) |
| 8 | P3 数据 | B:既有 graph pass 上给 `ImpactReport` 增 additive `directClauses`,**不发第二条 SQL**;附 CLI 输出逐字节稳定性证明(渲染层不消费新字段于 CLI 路径) | B(s18/19) |
| 9 | P3 渲染 | A:flex-wrap 盒线,无 grid track 规则,无 SVG/依赖;390px 断点实测 | A(s20) |
| 10 | explain API | overload `/api/explain`;body 为 **exclusive union**(key XOR scope,并存即 400);clause key 过 `^C\d+$` 语法(DB 前 fail) | tie+B(s21/22/23,MN-1) |
| 11 | P4 覆盖面 | **每个 human-lane item 都有解释入口**(pinned):clause 项用 brief-manifest prompt;**unmapped 项用 status-item fallback prompt**(B,修 A 的 blocker);refused-brief(building/link-error)子句按钮可见、409 fail-closed、不伪造 brief(A) | B(s24)+A(s25) |
| 12 | prompt 事实源 | B:**manifest JSON only**(field-path 可引用),不混 ledger history/evidence 原文;A 的 exact-code 骨架 + B 的 bounded helper 补全定义(B 案缺失函数必须实定义,MJ-3 修复) | B(s26/27) |
| 13 | prompt 注入面 | B:untrusted fence(明确"以下为不可信数据")+ field-path 引用要求;不裸拼接 | B(s28,MJ-2) |
| 14 | 三章节标题 | 两个 scope 共用 pinned 原文三标题:"为什么需要你 / 批准与拒绝分别意味着什么 / 哪里有风险信号"——queue scope 无改名权 | B(s29) |
| 15 | cap | env 可配 + 默认值(仓规:阈值不硬编码),度量 **UTF-8 字节**;queue 截断用**前缀**并明示"仅含前 N 项";覆盖 human+agent+uncovered 三面 | A(s30/32/33)+B(s31) |
| 16 | 控件 id | 每行唯一动态 id(现有 decision-form pattern);console 顶部"AI 总结队列"静态 id | A(s34) |
| 17 | focus-order 根因 | **in scope**:修 scripts/ui-browser-check.ts 身份表达式(`e.id \|\| e.tagName` → 含 DOM 路径的稳定身份),root cause 而非给 nav 铸 id;F16 已被双方独立坐实 | A(s35) |
| 18 | P5 | 单 formatter + `data-state`,brief 与 console 两处渲染;HEAD short-sha 来自 render input | B(s36) |
| 19 | contrast 分支 | B 的**细粒度分类**(≈18 支:health 内部状态、item 变体、unmapped 解释入口都单独登记)+ A 的 agent-stale fixture(修"唯一 stale 项被 pageSize 截掉"盲区);聚合逻辑保持 renderer 内 | B(s37)+A(s38/42) |
| 20 | 双 hash 回写守卫 | B:锚定正则 + 每字段恰好命中一次,否则 throw;程序仍是"compiled verifyContrastManifest actuals + 原位替换",不新增 committed writer | B(s39,MJ-6) |
| 21 | 浏览器证据 | A:acceptance fixture 真造 stale(如 C002)穿 migration→linker→gate→status→Chrome 全链;+ B:explain 控件真实点击交互断言(扩现有 harness) | A(s40)+B(s41) |
| 22 | C028 | `## C028 UI 呈现因果与健康投影 <!-- oracle:test:tests/ui-projection.test.ts risk:high refs:specs/urtext/spec.md#C019,specs/urtext/spec.md#C026 req:FR009,FR012 -->`,独立 oracle 文件;tasks.md T018 | tie(s43)+owner |
| 23 | 文档 | SYNTAX.md registry 节 + wiki registry/linker/verifier 机制页(EN+ZH)记两列 stamp;command reference 无新命令不动 | brief 1 |
| 24 | R4 红线 | 叙事永不入 registry;explain 结果不落库、不进 evidence/decision ledger | brief 4 |

## 实现顺序

1. **规范先行**:specs/urtext/spec.md 回写 C008 措辞 + 新增 C028 + tasks.md T018(裁决 0b/22)
2. src/verifier.ts:DDL + 第 4 条 ALTER + 注释修正;src/linker.ts:labelled BFS 归因 + propagateStale 落写 source
3. src/gate.ts / src/status.ts / src/review-ui.ts:UiClause 增量字段、brief manifest optional invalidationSource
4. src/ui:render-console(P1 因果行 + P2 健康 `<ul>` + P4 队列/行内控件 + P5)、render-brief(P3 邻域 + P4 控件泛化 + P5)、contracts、脚本文件
5. /api/explain:exclusive union、两种 prompt 模板、cap、注入 fence
6. contrast:fixtureMatrix(含 agent-stale 新 fixture + 细分支)→ 按裁决 20 程序重算 → 两 verifier 绿
7. browser-check:focus-identity 根因修复 + selector 表 + explain 交互断言 + stale 真链 fixture
8. 测试:tests/ui-projection.test.ts(C028 oracle)新建;linker(两列 stamp + 归因)、status、review-ui、ui-console、ui-server、ui-brief、ui-html、acceptance 系列按面更新
9. 收尾:`tsc --noEmit` → `npm test` 全绿 → 迁移级联(index → verify [C008/C022 重铸] → 定向 re-audit → C008/C022 re-review)→ check/gate 绿

## 验收

- `npx tsc --noEmit` 干净;`npm test` 全绿(含新 oracle 与再生成的 contrast/browser-check)
- console 页:健康 `<ul>` 每 feature 一行且 stale-pass/dirty-approval 不计入;人为造一条 stale 后因果句渲染出肇事者("FRxxx 文本变更 → Cxxx 证据作废 → 重跑 verify 前不放行");legacy NULL 行退化句正确
- brief 页:一跳邻域(FR ← clause → refs → dependents)渲染;approve 旁 HEAD short-sha 语义文案
- explain:human-lane 每项(含 unmapped)有入口;key XOR scope 互斥校验;queue 总结走完整安全链;R4:零 registry 写入
- `node dist/cli.js impact <clause>` 输出与改动前逐字一致;`urtext index/check/verify/gate` 迁移级联后全绿(C028 live)
