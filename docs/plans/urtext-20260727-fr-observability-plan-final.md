# Urtext FR Observability — 最终裁决方案(round 2 owner synthesis)

> 构建契约。基底裁决如下表;实现细节冲突时:本文件 > 各攻击文档的 fix 建议 > Plan A(opus)> Plan B(codex)。
> Plans: docs/plans/urtext-20260727-fr-observability-plan-{opus,codex}.md
> Attacks: .urtext/attack2-on-opus.md(Codex 攻 A)、.urtext/attack2-on-codex.md(Opus 攻 B)
> Pinned brief 仍全部有效: docs/plans/urtext-20260727-fr-observability-brief.md(见仓库内副本)

## 裁决总表

| # | 争点 | 裁决 | 采纳 |
|---|---|---|---|
| 1 | linker API | 新增 `impactRequirement(db, RequirementKey)`,`impact()` 逐字不动;返回 typed outcome `{kind:'found',report}\|{kind:'unknown_requirement',target}`,CLI 负责文案 | B |
| 2 | report 形状 | `{source, directClauses, affectedClauses(含 direct), affectedTasks}`;direct 判定=唯一解析的 req 边(candidates.length===1,与 uncoveredRequirements 同真值);directClauses 以 localeCompare 排序后再种入闭包 | B 形状 + A 排序(MJ-1) |
| 3 | CLI seam | `export const run` + `isMain()` 守卫(模式已被 scripts/ui-browser-check.ts:922 证明);保留 `parseClauseTarget` 原文,新增 FR target parser;clause 路径 stdout 逐字不变;FR 输出单列表带 `[direct]/[transitive]` 标记,无 title 行 | A seam(BL-1)+ B parser/输出(85-88) |
| 4 | C025 oracle | 新文件 `tests/fr-impact.test.ts`:linker 语义 + import `run` 端到端执行真实 CLI(unknown FR 退出 1、clause 路径回归);acceptance 阶段另跑 built `dist/cli.js impact` smoke | A oracle 哲学 + B smoke(110) |
| 5 | UI resolver 输入 | clause 的 `reqs` JSON 列(源码序,round-1 已给 brief 用)——同时可用于成功页与 409 路径,天然解决 MJ-2 排序矛盾;resolver 为 UI 内部件,不入 root export;root 只新增 `impactRequirement` | Owner 合成(B 方向 + MJ-2 修复) |
| 6 | View 类型 | UI-owned `RequirementBindingView` 三态 union 于 src/ui/contracts.ts(resolved/dangling/ambiguous),不 type-import linker 内部类型(MJ-8) | B |
| 7 | 成功 brief 页 | req bindings 区块,resolved 态显示 FR id+title;**无 empty 分支**——C020 保证 ready 修订 ≥1 绑定,不渲染不可达状态(MJ-4) | Owner(MJ-4 fix) |
| 8 | 409 error shell | 渲染 **仅 broken** bindings(filter state!=='resolved',MJ-3),dangling/ambiguous 用 `[data-tone="danger"]`;resolved 绑定不出现在 error shell → 不引入 error 页 ok-consumer | B 方向 + MJ-3 fix |
| 9 | Console 页 | "Uncovered intent" `<ul>`(非 table,ui-console.test.ts:198);位于 queue table + paginator **之后、分页 DOM 域之外**(MN-2);标题计数=渲染数组 length(MJ-7);summary 不动;空态遵守现有 chip 纪律(MN-4) | A 布局/计数 + 修复 |
| 10 | contrast source-hash 表 | `src/ui/contracts.ts` **加入两套实现**的 source 列表(tests/ui-component-contrast.test.ts 与 scripts/ui-browser-check.ts 同步)——两侧攻击均认可扩表有效(97) | A |
| 11 | canonical branches | 恰好 +5:`console.uncoveredIntent.empty/nonEmpty`、`brief.requirementBindings.resolved`、`error.requirementBindings.dangling/ambiguous`;新 deterministic `error-broken-requirements` fixture(仅 broken 绑定)+ `e-danger-default` consumer;9 个 console fixture 同步补 `uncoveredRequirements` 与 `counts.uncovered` 且二者一致(渲染只读列表) | B 拆分 + MJ-3/4/7 修复 |
| 12 | manifest 再生成 | **不新增 committed writer**(MJ-5):按 compileAccBuild 全套装饰编译 $ACC(含 package.json type:module + node_modules symlink,MJ-6),调用已导出的 `verifyContrastManifest` 取 actuals,锚定正则原位替换恰好两个 64-hex 字段(带"未命中即 throw"守卫),随后两套 verifier 全绿复核 | A(MJ-5 实证) |
| 13 | browser acceptance | 不加第八页(D13);console 页 selector 增 `#uncovered-intent`、brief 页增 `[data-section="requirement-bindings"]`;断言必须核对真实投影的 FR key/title(101);fixture 未覆盖 FR 用 **FR002**(102);server 测试锁 409 broken-binding markup(100) | B + A fixture id |
| 14 | 性能 | 不做 1k synthetic 基准(109);404 路径不整建 liveGraph(MN-5)——FR 活性判定用窄查询 | A + MN-5 |
| 15 | C026 | `## C026 UI 呈现需求绑定与未覆盖意图 <!-- oracle:test:tests/ui-req-observability.test.ts risk:high refs:specs/urtext/spec.md#C019,specs/urtext/spec.md#C023 req:FR012 -->`——独立 oracle 文件,避免 C026 断言破坏时把已裁决的 C019 重新拉回人工队列(MN-6) | A refs + 独立文件 |
| 16 | C025 | `## C025 FR 影响可机械查询 <!-- oracle:test:tests/fr-impact.test.ts risk:low req:FR013 -->`,无 refs(107);tasks.md 增 T017 引用 C025,C026 | B |
| 17 | 文档 | EN+ZH command reference 的 impact 行 + EN+ZH linker-impact mechanism 页同步 FR target(106);C015 oracle 保持绿 | B |
| 18 | 编译卫生 | MN-1(handleBrief 片段类型)、MN-3(死代码 uniqueClauseKeys)、attack2-on-opus finding 3(render-brief 缺类型导入)在实现中直接规避;strict+exactOptionalPropertyTypes 全程 | 攻击修复 |

## 实现顺序

1. `src/linker.ts`:`RequirementKey`/`RequirementImpactReport`/outcome 类型 + `impactRequirement`(唯一解析真值与 uncoveredRequirements 共享辅助函数);`src/index.ts` 导出 `impactRequirement`
2. `src/cli.ts`:FR target parser、impact 分支扩展、usage 文案、`export const run` + `isMain()` 守卫(入口行为不变)
3. `src/ui/contracts.ts`:`RequirementBindingView` union + console/brief view 扩展;resolver(读 clauses.reqs 列 + 窄活性查询)接线于 review-ui/ui-server 数据层
4. `src/ui/render-brief.ts`:成功页 bindings 区块(resolved,无空分支);error shell 仅 broken 区块;`src/ui/render-console.ts`:uncovered `<ul>`(位置/计数按裁决 9)
5. contrast manifest:fixtureMatrix 扩展(裁决 11)→ 按裁决 12 程序重算双 hash → 两 verifier 复核
6. browser-check selector 表 + acceptance fixture(FR002)+ server 409 断言
7. 测试:tests/fr-impact.test.ts、tests/ui-req-observability.test.ts 新建;ui-console/ui-server/review-ui/ui-html/ui-browser-check/ui-acceptance-fixture 既有测试按面更新
8. Dogfood:specs/urtext/spec.md C025/C026 + tasks.md T017;wiki 四处文档
9. 收尾:`npx tsc --noEmit` → `npm test` 全绿 → `dist/cli.js` impact(clause 逐字回归 + FR 路径)→ index/check/verify/status 全绿

## 验收

- `npx tsc --noEmit` 干净;`npm test` 全绿(含更新后的 contrast/browser-check/acceptance)
- `node dist/cli.js impact specs/urtext/spec.md#C003`(clause 路径)输出与改动前逐字一致
- `node dist/cli.js impact specs/urtext/spec.md#FR013` 列出 C020-C026 相关闭包;`#FR999` 明确报错退出 1
- console 页渲染 uncovered 空态;人为删除一条绑定后非空态渲染该 FR;brief 详情页渲染 req 绑定
- `urtext index/check/verify` 迁移后全绿;C025/C026 进入 live 并通过
