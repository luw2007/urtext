- [x] T001 clause parser 与 fail-closed 错误目录 <!-- role:coder clauses:C001 -->
    解析层：C-id 标题、anchor 字段、missing_oracle/invalid_oracle_kind/invalid_risk。
- [x] T002 注册表不可变修订链 <!-- role:coder depends:T001 clauses:C002,C003 -->
    unchanged / indexed(ready|building) / tombstoned；unknown_clause 跨引用检查。
- [x] T003 oracle runner 与证据库 <!-- role:coder depends:T002 gate:true clauses:C004 -->
    test/cmd/diff-scope 执行，manual pending，metric 显式 fail；evidence append-only。
- [x] T004 linker 与影响分析 <!-- role:coder depends:T003 clauses:C007,C008 -->
    refs 建图（clause_refs）、unknown_ref fail-closed、text_hash stale 传播、urtext impact。
- [x] T005 DWARF clause↔code 映射与 unmapped 执法 <!-- role:coder depends:T004 gate:true clauses:C009,C010 -->
    clause_code_map、diff 交叉验证的 map/ack、check --diff unmapped 检测、urtext blame。
- [x] T006 元验证协议与风险分级裁决门 <!-- role:coder depends:T005 gate:true clauses:C011,C012 -->
    audit_verdicts、异源 export/import 覆盖率、gate 聚合 evidence/audit/stale/unmapped。
- [x] T007 unsafe lane：高危子句人工代码审查工作流 <!-- role:coder depends:T006 gate:true clauses:C013 -->
    reviews 表、review --approve/--reject 绑定 HEAD、gate 接入 review 放行/阻断高危子句。
- [x] T008 记忆层：manual 子句 Decision ledger <!-- role:coder depends:T007 gate:true clauses:C014 -->
    decisions 表、decide --pass/--fail 绑定 HEAD、gate 接入 Decision 放行 manual 子句、urtext decisions 查询。
- [x] T009 文档 wiki 与命令参考一致性 oracle <!-- role:coder depends:T008 clauses:C015 -->
    docs/wiki/ 三层内容；scripts/oracle-wiki.sh command-coverage 对 cli.ts 命令集 grep-presence 判定。
- [x] T010 操作台 status 双车道队列 <!-- role:coder depends:T009 clauses:C016 -->
    item 键控队列、owner 车道、typed reason、wip 告警；status/gate/check 的 --json envelope。
- [x] T011 决策简报 brief 与 manifest v1 <!-- role:coder depends:T010 clauses:C017 -->
    条文全量+映射内容+内容寻址证据 digest+影响闭包；ready-guard；CLI/ui 共享文本渲染器。
- [x] T012 批准前置强化与 ui 操作台 <!-- role:coder depends:T011 gate:true clauses:C018 -->
    brief-hash+clean-worktree domain 守卫、gate 脏树重路由、ui 双车道+/brief+hash 直通。
- [x] T013 UI Spec 影响浏览与 Blame Diff <!-- role:coder depends:T012 gate:true clauses:C019 -->
    全部 clause 浏览、风险/证据/dependency 状态、映射范围真实 diff、workspace unmapped 操作指引与导航刷新。
- [x] T014 UI 重设计 browser/evidence 工具与文档同步 <!-- role:coder depends:T013 clauses:C019 -->
    scripts/ui-browser-check.ts + ui-browser-check-wrapper.mjs + ui-evidence-manifest.ts；schema v2 contrast manifest 绑定 source/render hashes；英中命令参考同步。trusted final gate 已通过 cmux 真实交互与 Chrome 3 页 × 3 viewport × 2 theme 矩阵：998/998 assertions、18 screenshots、0 failure。
- [ ] T015 console 分页与页面拆分 <!-- role:coder depends:T014 gate:true clauses:C019 -->
    四路由 console-family、每路由独立服务端分页、All Specs 跨页完整可达、audit 归属与 browser/contrast/installed-consumer 验收同步。
