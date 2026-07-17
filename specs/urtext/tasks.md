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
