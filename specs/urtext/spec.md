# Urtext 核心行为

本 feature 是自举闭环：Urtext 用自己的语法描述自己的核心行为，
每条子句绑定本仓库的真实 oracle。`urtext verify` 全绿即设计闭环成立。

## 需求（FR）

本节是子句的上游意图：FR 说"为什么必须如此"，子句说"如何判定它成立"。
FR 是意图，不可判定——带 `oracle:` 或 `risk:` 的 FR 是索引期错误。

### FR001 规范性主张必须可判定

一条声称系统"必须如何"的陈述，若没有任何机械判定手段，就无法与愿望区分。
系统必须拒绝它进入执行体系，而不是把它降级为"较弱的真"。

### FR002 判定必须来自真实执行的证据

完成度必须是证据聚合，不是自述、不是评分。任何"通过"都必须能回指到一次
真实运行及其可复算的输出。

### FR003 事实账本必须不可改写

规范的历史本身是审计对象。索引只能追加，不能改写既有修订；删除只能追加墓碑。
没有不可改写的账本，就没有可信的回溯。

### FR004 引用必须完整，悬空即失败

跨文件引用与 checklist 对子句的引用一旦悬空，图就在说谎。校验必须发生在
全 workspace 快照上，而不是依赖引用方碰巧被重新索引。

### FR005 上游变更必须自动作废下游结论

上游条文文本一变，依赖它的结论就不再被证据支撑。系统必须自动把这些结论标记为
待重验，而不是依赖人记得去重跑。

### FR006 代码变更必须可归因到条文

事实源从代码翻转到规范，只有当每一处代码变更都能归因到某条子句、显式豁免或
规范回写时才成立。未归因的变更必须阻断合入。

### FR007 自动通过必须是最窄的路径

自动通过只覆盖"低风险 + 证据通过 + 异源审计同意 + 非 stale"这一条窄路；
其余一切情况都必须显式路由到人，并附可读原因。

### FR008 高危路径必须有绑定当下事实的人工签核

高危子句证据全绿也不足以放行：人必须看过当下的代码与上下文并签核；签核绑定
当时的 HEAD 与内容哈希，事实一变即失效。

### FR009 人的注意力必须收敛

人一次只应面对一个待办面和一个裁决上下文，而不是自行合并多条命令的输出。
注意力是最稀缺的资源，分散即漏判。

### FR010 系统对自身的描述不得漂移

文档与命令集、子句与实现必须同步演进。过期的文档是静默的谎言，
正是本系统要消除的东西。

### FR011 工程基线必须持续可编译

严格类型检查是其余一切保证的地基；地基红着的时候，别的保证都无从谈起。

### FR012 裁决上下文必须在图形界面完整可达

命令行之外，人必须能在界面上浏览全部活跃子句、区分各类 stale、并看到映射范围内
的真实代码 diff——否则"人做裁决"只是口号。

### FR013 意图与实现之间必须有机械可查的绑定

需求靠纪律对齐规范，就是本系统论证过必然失败的那种模式。每条规范性子句必须
声明它守的是哪条意图，每条意图必须能被查出有没有人守。

## C001 无 oracle 的规范性子句被拒绝 <!-- oracle:test:tests/clause-parser.test.ts risk:high req:FR001 -->

VISION P1：规范性子句必须绑定 oracle。解析层将 `missing_oracle` 记为错误，
注册层使该修订停在 `building`，永不可执行。

## C002 checklist 引用未声明的子句被拒绝 <!-- oracle:test:tests/registry.test.ts risk:high req:FR004 -->

`tasks.md` 的 `clauses:` 引用必须解析到同 feature 单元内的已声明子句，
否则 `unknown_clause` 使修订停在 `building`（fail-closed）。

## C003 修订链不可变 <!-- oracle:test:tests/registry.test.ts req:FR003 -->

同内容 no-op；新内容追加修订；删除追加 tombstone。历史修订永不被改写。

## C004 oracle 执行产出证据并驱动退出码 <!-- oracle:test:tests/verifier.test.ts risk:high req:FR002 -->

`urtext verify` 对每条 `ready` 子句执行 oracle，证据 append-only 落库；
任一 fail → 退出码 1。完成率是证据聚合，不是评分。

## C005 全仓类型检查通过 <!-- oracle:cmd:./scripts/oracle-typecheck.sh req:FR011 -->

strict + exactOptionalPropertyTypes 下 `tsc --noEmit` 干净。

## C006 CLI 帮助面命令集变更需人工确认 <!-- oracle:manual req:FR010 -->

当前命令集 `index` / `check` / `verify` / `status` / `brief` / `impact` /
`map` / `ack` / `blame` / `audit` / `gate` / `review` / `decide` /
`decisions` / `ui` / `distill` 之外的新命令，需要人工确认进入本子句或新增子句。

## C007 悬空引用被拒绝 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C003 req:FR004 -->

`refs` 在全 workspace 最新活跃修订上解析；目标文件或子句不存在即 `unknown_ref`，
`urtext check` 退出码 1。目标被改名/删除而引用方文件未变的悬空引用同样被捕获
（check 阶段全量校验，不依赖引用方重索引）。

## C008 上游文本变更传播 stale 并作废证据 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C004 req:FR005,FR002 -->

子句 text_hash（标题+正文）变更时，沿 `clause_refs` 反向闭包标记依赖子句 stale，
其既有证据打上 `invalidated_at`——证据唯一可变列，作废不删除（审计保留）。

## C009 clause→code 映射由真实 diff 交叉验证 <!-- oracle:test:tests/dwarf.test.ts risk:high req:FR006 -->

`urtext map` 声称的子句→代码范围必须与当时真实 `git diff` 相交才落库
（provenance 不信 LLM 自述，信 diff，DECISIONS D4）。范围不相交即
`unverified_range` 拒绝；子句非活跃即 `unknown_clause` 拒绝。

## C010 unmapped change 被执法 <!-- oracle:test:tests/dwarf.test.ts risk:high refs:specs/urtext/spec.md#C009 req:FR006 -->

`urtext check --diff` 扫描工作区 hunk：无法归因到子句映射、显式 ack 或
spec 回写的变更标记为 unmapped，退出码 1——事实源翻转的执法点（VISION P3）。

## C011 元验证只读证据且异源、分歧不静默 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C004 req:FR007 -->

`audit --export` 只导出已判定证据的覆盖包（stale/pending 排除），审计 verdict
绑定具体 evidence_id（只读证据不重跑，异源 preset 见 DECISIONS D3）；
`disagree` 计入且永不静默——升级人工。

## C012 风险分级裁决门 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C011 req:FR007 -->

`urtext gate`：子句仅当 `low + evidence=pass + audit=agree + 非 stale` 自动通过；
high/缺证据/失败/pending/disagree/unaudited/stale 任一 → 人工，附原因；
存在 unmapped 变更时整体判定人工（VISION P4）。

## C013 unsafe lane：高危子句需绑定 HEAD 的人工代码审查 <!-- oracle:test:tests/review.test.ts risk:high refs:specs/urtext/spec.md#C012 req:FR008 -->

`risk:high` 子句证据全绿也不自动通过（VISION P5：代码是唯一可 review 的事实）；
`urtext review --approve` 记录人工代码审查，绑定当时 HEAD sha——HEAD 变更即失效，
须重审。仅高危子句进入本车道；`--reject` 或无审查保持人工。审查记录持久落库。

## C014 记忆层：manual 子句人工裁决落 Decision ledger <!-- oracle:test:tests/decision.test.ts risk:high refs:specs/urtext/spec.md#C012 req:FR008 -->

manual oracle 子句永远 pending，无可运行 oracle 判定；`urtext decide --pass|--fail`
记录人工裁决，绑定当时 HEAD sha（HEAD 变更即失效），持久落 `decisions` 表
（DESIGN §7 记忆层）。仅 manual 子句可裁决——runnable oracle 子句由客观证据判定
（守 P2）。gate 见当前 HEAD 的 pass Decision 即放行该 manual 子句。

## C015 文档 wiki 命令参考覆盖真实命令集 <!-- oracle:cmd:scripts/oracle-wiki.sh%20command-coverage risk:low refs:specs/urtext/spec.md#C006 req:FR010 -->

文档 wiki（docs/wiki/）宣传机制；命令参考漂移出真实命令集即静默谎言，正是本系统
要消除的（VISION P3、CLAUDE §18 单一事实源）。`scripts/oracle-wiki.sh command-coverage`
对 cli.ts 的每个命令做 grep-presence 判定——文本在=覆盖在，缺任一命令即 exit 1。
与 C006（命令集变更需人工确认）互补：C006 管命令集本身变更，本条管文档随之同步。

## C016 status 双车道队列完整且 item 键控 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C012 req:FR009 -->

`urtext status` 把全部待办合并为单一队列：agent 车道（缺证据/失败/stale/未审计——
无需判断即可修复的前置项）与人车道（前置已满足的裁决项与 unmapped）。一个子句
仅出现一次（主阻塞+次因）；存在任一 agent 前置时不进入人车道。`--wip-limit`
（默认 10，临时值）超限告警。

## C017 brief 单命令产出完整裁决上下文 <!-- oracle:test:tests/brief.test.ts refs:specs/urtext/spec.md#C009 req:FR009,FR008 -->

`urtext brief` 对任一活跃子句产出条文全量（title/body/oracle/risk/refs）、映射
代码内容、证据 digest（内容寻址——等结果重跑不换哈希）、audit 状态、影响闭包与
brief-hash。building/link-error 修订拒发可批准哈希（fail-closed）；anchor-only
的 risk/oracle 变更必须改变哈希（text_hash 只含标题+正文，不足以承载）。

## C018 high-risk 批准的新鲜度与洁净前置 <!-- oracle:test:tests/brief-gate.test.ts risk:high refs:specs/urtext/spec.md#C013 req:FR008 -->

`review --approve` 与高危 manual 的 `decide --pass` 必须携带与当前内容重算一致的
brief-hash 且 worktree 洁净，否则以 brief_required / brief_stale / dirty_worktree
fail-closed。守卫在 domain 写路径（recordReview/recordDecision），CLI 与 ui 同受检。
HEAD 绑定语义不变（M5a）；--reject/--fail 无前置（保守方向不设门）。gate 在
worktree 脏时把已批准高危子句重新路由人工。

## C019 UI 完整呈现 Spec 影响与映射 Diff <!-- oracle:test:tests/spec-impact-interactions.test.ts risk:high refs:specs/urtext/spec.md#C017 req:FR012 -->

`urtext ui` 必须可浏览全部 live clause；详情页区分风险、当前证据 stale、下游
dependency stale 与潜在 impact，并展示从 clause mapping 的记录 HEAD 到当前工作树、
仅与映射范围相交的真实 Blame Diff。无映射、无变化、diff 失败分别显示明确状态；
workspace unmapped hunk 提供精确 map/ack 命令模板与刷新入口。

## C020 规范性子句必须绑定需求 <!-- oracle:test:tests/registry.test.ts risk:high refs:specs/urtext/spec.md#C001 req:FR013 -->

每条 `C\d+` 子句必须至少声明一条 `req:` 绑定，否则 `missing_requirement`
使修订停在 `building`——与 `missing_oracle` 对称：一条不知道自己在守什么意图的
规范锁，是作者的疏忽，不是一种较弱的真。FR 带 `oracle:`/`risk:` 同为索引期错误。

## C021 悬空需求绑定在 check 阶段被拒绝 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C007 req:FR013,FR004 -->

`req:` 在全 workspace 最新活跃修订上解析：裸 `FR\d+` 在同 feature 单元内解析，
`path#FR\d+` 精确解析。无法解析即 `unknown_req`，`urtext check` 退出码 1
（与 `unknown_ref` 同语义：目标被删/改名而绑定方文件未变同样被捕获）。

## C022 需求文本变更传播 stale 到绑定子句 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C008 req:FR005 -->

FR 的 text_hash（标题+正文）变更时，沿 `clause_reqs` 反向闭包标记全部绑定子句
stale，并继续沿 `clause_refs` 传播到它们的下游。FR 变更不铸出子句新修订，
所以绑定子句本身必须被打戳——否则意图已变而证据仍绿。

## C023 未覆盖需求在 status 中可见 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C016 req:FR013,FR009 -->

`urtext status` 报告零活跃绑定子句的活跃 FR。未覆盖意图是人车道信息，
不是 agent 可修项：它不进队列、不计入 counts.human/wip、不改变退出码——
把它做成阻断项会惩罚"先写下意图再补锁"这一正当工作流。

## C024 grammar version 强制旧注册表追加重扫 <!-- oracle:test:tests/registry.test.ts risk:high refs:specs/urtext/spec.md#C003,specs/urtext/spec.md#C020 req:FR003,FR013 -->

`revisions.grammar_version` 参与 clause-file no-op 判定。历史行保留 version 0 且绝不
改写；FR 语法 parser 写 version 1。升级后即使文件字节未变，也必须追加新修订并
重新执行 mandatory-req 校验，随后同 content + version 1 才可恢复 unchanged。
