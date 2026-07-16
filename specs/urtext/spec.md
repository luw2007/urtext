# Urtext 核心行为

本 feature 是自举闭环：Urtext 用自己的语法描述自己的核心行为，
每条子句绑定本仓库的真实 oracle。`urtext verify` 全绿即设计闭环成立。

## C001 无 oracle 的规范性子句被拒绝 <!-- oracle:test:tests/clause-parser.test.ts risk:high -->

VISION P1：规范性子句必须绑定 oracle。解析层将 `missing_oracle` 记为错误，
注册层使该修订停在 `building`，永不可执行。

## C002 checklist 引用未声明的子句被拒绝 <!-- oracle:test:tests/registry.test.ts risk:high -->

`tasks.md` 的 `clauses:` 引用必须解析到同 feature 单元内的已声明子句，
否则 `unknown_clause` 使修订停在 `building`（fail-closed）。

## C003 修订链不可变 <!-- oracle:test:tests/registry.test.ts -->

同内容 no-op；新内容追加修订；删除追加 tombstone。历史修订永不被改写。

## C004 oracle 执行产出证据并驱动退出码 <!-- oracle:test:tests/verifier.test.ts risk:high -->

`urtext verify` 对每条 `ready` 子句执行 oracle，证据 append-only 落库；
任一 fail → 退出码 1。完成率是证据聚合，不是评分。

## C005 全仓类型检查通过 <!-- oracle:cmd:./scripts/oracle-typecheck.sh -->

strict + exactOptionalPropertyTypes 下 `tsc --noEmit` 干净。

## C006 CLI 帮助面保持三命令 <!-- oracle:manual -->

`index` / `check` / `verify` 之外的新命令需要人工确认进入本子句或新增子句。
