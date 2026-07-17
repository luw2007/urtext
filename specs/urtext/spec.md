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

## C006 CLI 帮助面命令集变更需人工确认 <!-- oracle:manual -->

当前命令集 `index` / `check` / `verify` / `impact` / `map` / `ack` / `blame`
之外的新命令，需要人工确认进入本子句或新增子句。

## C007 悬空引用被拒绝 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C003 -->

`refs` 在全 workspace 最新活跃修订上解析；目标文件或子句不存在即 `unknown_ref`，
`urtext check` 退出码 1。目标被改名/删除而引用方文件未变的悬空引用同样被捕获
（check 阶段全量校验，不依赖引用方重索引）。

## C008 上游文本变更传播 stale 并作废证据 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C004 -->

子句 text_hash（标题+正文）变更时，沿 `clause_refs` 反向闭包标记依赖子句 stale，
其既有证据打上 `invalidated_at`——证据唯一可变列，作废不删除（审计保留）。

## C009 clause→code 映射由真实 diff 交叉验证 <!-- oracle:test:tests/dwarf.test.ts risk:high -->

`urtext map` 声称的子句→代码范围必须与当时真实 `git diff` 相交才落库
（provenance 不信 LLM 自述，信 diff，DECISIONS D4）。范围不相交即
`unverified_range` 拒绝；子句非活跃即 `unknown_clause` 拒绝。

## C010 unmapped change 被执法 <!-- oracle:test:tests/dwarf.test.ts risk:high refs:specs/urtext/spec.md#C009 -->

`urtext check --diff` 扫描工作区 hunk：无法归因到子句映射、显式 ack 或
spec 回写的变更标记为 unmapped，退出码 1——事实源翻转的执法点（VISION P3）。
