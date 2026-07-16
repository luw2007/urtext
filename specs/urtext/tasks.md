- [x] T001 clause parser 与 fail-closed 错误目录 <!-- role:coder clauses:C001 -->
    解析层：C-id 标题、anchor 字段、missing_oracle/invalid_oracle_kind/invalid_risk。
- [x] T002 注册表不可变修订链 <!-- role:coder depends:T001 clauses:C002,C003 -->
    unchanged / indexed(ready|building) / tombstoned；unknown_clause 跨引用检查。
- [x] T003 oracle runner 与证据库 <!-- role:coder depends:T002 gate:true clauses:C004 -->
    test/cmd/diff-scope 执行，manual pending，metric 显式 fail；evidence append-only。
- [ ] T004 linker 与影响分析 <!-- role:coder depends:T003 clauses:C003 -->
    refs 建图、stale 传播、urtext impact。（下一里程碑）
