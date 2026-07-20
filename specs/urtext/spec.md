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

当前命令集 `index` / `check` / `verify` / `status` / `brief` / `impact` /
`map` / `ack` / `blame` / `audit` / `gate` / `review` / `decide` /
`decisions` / `ui` 之外的新命令，需要人工确认进入本子句或新增子句。

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

## C011 元验证只读证据且异源、分歧不静默 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C004 -->

`audit --export` 只导出已判定证据的覆盖包（stale/pending 排除），审计 verdict
绑定具体 evidence_id（只读证据不重跑，异源 preset 见 DECISIONS D3）；
`disagree` 计入且永不静默——升级人工。

## C012 风险分级裁决门 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C011 -->

`urtext gate`：子句仅当 `low + evidence=pass + audit=agree + 非 stale` 自动通过；
high/缺证据/失败/pending/disagree/unaudited/stale 任一 → 人工，附原因；
存在 unmapped 变更时整体判定人工（VISION P4）。

## C013 unsafe lane：高危子句需绑定 HEAD 的人工代码审查 <!-- oracle:test:tests/review.test.ts risk:high refs:specs/urtext/spec.md#C012 -->

`risk:high` 子句证据全绿也不自动通过（VISION P5：代码是唯一可 review 的事实）；
`urtext review --approve` 记录人工代码审查，绑定当时 HEAD sha——HEAD 变更即失效，
须重审。仅高危子句进入本车道；`--reject` 或无审查保持人工。审查记录持久落库。

## C014 记忆层：manual 子句人工裁决落 Decision ledger <!-- oracle:test:tests/decision.test.ts risk:high refs:specs/urtext/spec.md#C012 -->

manual oracle 子句永远 pending，无可运行 oracle 判定；`urtext decide --pass|--fail`
记录人工裁决，绑定当时 HEAD sha（HEAD 变更即失效），持久落 `decisions` 表
（DESIGN §7 记忆层）。仅 manual 子句可裁决——runnable oracle 子句由客观证据判定
（守 P2）。gate 见当前 HEAD 的 pass Decision 即放行该 manual 子句。

## C015 文档 wiki 命令参考覆盖真实命令集 <!-- oracle:cmd:scripts/oracle-wiki.sh%20command-coverage risk:low refs:specs/urtext/spec.md#C006 -->

文档 wiki（docs/wiki/）宣传机制；命令参考漂移出真实命令集即静默谎言，正是本系统
要消除的（VISION P3、CLAUDE §18 单一事实源）。`scripts/oracle-wiki.sh command-coverage`
对 cli.ts 的每个命令做 grep-presence 判定——文本在=覆盖在，缺任一命令即 exit 1。
与 C006（命令集变更需人工确认）互补：C006 管命令集本身变更，本条管文档随之同步。

## C016 status 双车道队列完整且 item 键控 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C012 -->

`urtext status` 把全部待办合并为单一队列：agent 车道（缺证据/失败/stale/未审计——
无需判断即可修复的前置项）与人车道（前置已满足的裁决项与 unmapped）。一个子句
仅出现一次（主阻塞+次因）；存在任一 agent 前置时不进入人车道。`--wip-limit`
（默认 10，临时值）超限告警。

## C017 brief 单命令产出完整裁决上下文 <!-- oracle:test:tests/brief.test.ts refs:specs/urtext/spec.md#C009 -->

`urtext brief` 对任一活跃子句产出条文全量（title/body/oracle/risk/refs）、映射
代码内容、证据 digest（内容寻址——等结果重跑不换哈希）、audit 状态、影响闭包与
brief-hash。building/link-error 修订拒发可批准哈希（fail-closed）；anchor-only
的 risk/oracle 变更必须改变哈希（text_hash 只含标题+正文，不足以承载）。

## C018 high-risk 批准的新鲜度与洁净前置 <!-- oracle:test:tests/brief-gate.test.ts risk:high refs:specs/urtext/spec.md#C013 -->

`review --approve` 与高危 manual 的 `decide --pass` 必须携带与当前内容重算一致的
brief-hash 且 worktree 洁净，否则以 brief_required / brief_stale / dirty_worktree
fail-closed。守卫在 domain 写路径（recordReview/recordDecision），CLI 与 ui 同受检。
HEAD 绑定语义不变（M5a）；--reject/--fail 无前置（保守方向不设门）。gate 在
worktree 脏时把已批准高危子句重新路由人工。
