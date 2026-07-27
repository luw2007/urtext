# 命令参考

每条 Urtext 命令、它的签名、退出码，以及它写入的内容。
注册表(registry) 位于当前目录下的 `.urtext/registry.sqlite`，这也是
Urtext 自身写入的唯一状态。注意，`test` 和 `cmd` oracle(判据) 会在没有沙箱的情况下
以你的权限运行子进程（`npx vitest`，或你的命令）——
这些子进程可以访问网络或文件系统；Urtext 不会限制它们。

权威来源是 `urtext --help`；本页展开每一项。

## 校验与验证

### `urtext index`
扫描 `specs/` 并调和子句(clause)注册表。未改变的内容是 no-op；
改变的内容会追加一个修订(revision)。（删除墓碑化作为 registry API 存在，
但在 v0 中尚未接入 scanner，因此被删除文件的最后一个修订仍然
存活。）大多数其他命令会先运行这次扫描——例外是 `ack`、
`blame` 和 `decisions`，它们不会 index。Exit 0。

### `urtext check [--diff]`
先 index，再报告错误。任何 `building` 修订（带有解析或校验错误的文件）
或任何未知的跨文件 `ref` 都会 **Exit 1**。带 `--diff` 时，它
还会因未映射的 working-tree 改动而失败——也就是不对应任何子句的手工编辑。
这是语法和引用的 fail-closed 裁决门(gate)。

### `urtext verify [--incremental]`
先 index 和 check，再运行每个子句的 oracle，并记录只追加证据(evidence)。
校验或链接错误（在任何 oracle 运行之前）*或者*任何失败的
子句 oracle 都会 **Exit 1**。报告 pass-rate 和 manual-share：

```text
34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13% (8.4s)
```

带 `--incremental` 时，当工作区指纹（HEAD + 已跟踪 diff + 未跟踪内容 + 运行时身份）未变，verify 会复用此前通过且未失效的 `test`-oracle 判定——被复用的子句**不再追加新的证据行**。任何 git 可见改动、`fail`、已失效判定、非 `test` oracle，或修订为新增的子句都会重新执行。不带该标志时，所有可运行 oracle 照常逐个重跑；复用发生时汇总行会内联报告复用数，例如 `34 pass, 0 fail, 5 pending, 12 reused — pass rate 100%, manual share 13% (4.7s)`。

## 操作队列与简报

### `urtext status [--json] [--wip-limit <n>]`
把全部待办合并为单一 item 键控队列，按"谁能行动"分车道。**人车道**放前置
已满足的裁决项——待审的高风险 review、未裁决的 manual 子句、audit 分歧、
未映射的 working-tree 改动。**agent 车道**放可修复的前置项——缺失/失败的
证据、stale 子句、未审计证据；带任一 agent 前置的子句不进入人车道，直到
前置解决。每项只出现一次，带主阻塞、次因和建议动作。`--wip-limit`
（默认 10，临时值）在人队列超限时告警——批量过大审查质量会退化。
`--json` 输出 `urtext.status/1` envelope。有任何待办即 **Exit 1**。

### `urtext brief <spec-path>#<clause-id> | <file>:<line>[-<end>] [--json]`
一条命令拿到一个子句的完整裁决上下文：条文与 anchor、从 working tree 读取的
映射代码内容、最新证据（内容寻址 digest——等结果重跑不换哈希）、元审计状态、
影响闭包、review/decision 历史。末行是 **brief-hash**：`review --approve`
与高风险 `decide --pass` 必须经 `--brief <hash>` 引用的新鲜度令牌。处于
`building` 修订或引用悬空的子句**拿不到可批准哈希**（fail-closed）。
`<file>:<line>` 目标经 `blame` 解析并输出每个约束子句的简报。任一简报被
拒绝即 **Exit 1**。

## 影响分析

### `urtext impact <spec-path>#<clause-id>`
列出如果命名子句发生变化会受影响的子句和任务——即 `refs` 图上的
反向闭包。Exit 0；当没有任何东西依赖该子句时，
打印空结果。

```text
$ urtext impact specs/urtext/spec.md#C004
Affected clauses (reverse closure):
  specs/urtext/spec.md#C008
  ...
Affected tasks:
  specs/urtext/tasks.md T003 oracle runner 与证据库 (cites C004)
```

### `urtext impact <spec-path>#FR<n>`
列出 `req:` 唯一解析到该需求的所有活跃子句，再列出它们在 `refs` 图上的反向闭包，
以及引用任一受影响子句的任务。单一子句列表用 `[direct]` / `[transitive]` 标识来源。
FR 已声明但无人守护时打印 `none` 并 Exit 0；FR 未声明或已 tombstone 时清楚报错并
Exit 1。

```text
$ urtext impact specs/urtext/spec.md#FR013
Affected clauses (direct + reverse closure):
  [direct] specs/urtext/spec.md#C020
  ...
```

## 子句 ↔ 代码映射 (DWARF)

### `urtext map <spec-path>#<clause-id> <file>:<start>-<end> [note…]`
记录子句→代码映射，并根据当前 HEAD 的真实 `git diff` 交叉验证。
声明的范围如果没有与实际 diff 相交就会被拒绝——
溯源信任的是 diff，而不是自我报告。

### `urtext ack <file>:<start>-<end> <reason…>`
确认一个有意未映射的改动。**reason 是必需的**——没有理由的
确认会被拒绝。这是给你不想（或不能）归因到某个子句的手工编辑
留下的显式逃生阀。

### `urtext blame <file>:<line>`
列出约束某一代码行的子句——也就是 `map` 的反向。未映射的行
会诚实地报告没有任何东西约束它：

```text
$ urtext blame src/verifier.ts:1
No clause constrains src/verifier.ts:1.
```

## 元验证与裁决

### `urtext audit --export | --import <file> | --run <claude|codex|traex|omp> [--model <model>] [--profile <profile>]`
跨模型元验证协议。`--export` 会写出证据覆盖包（`urtext-meta-audit/v0`），供不同
preset 的审计者使用；`--import` 读回其 `agree`/`disagree` 裁决。`--run` 是自动
链路：Urtext 导出当前证据，使用所选 headless CLI 的只读/无工具模式审计，严格校验每个
evidenceId 恰有一个裁决后才一次性导入。外部 CLI 缺失、超时、异常退出或输出不完整时
exit 2，且不会写入部分裁决；导入完成但存在 `disagree` 时 exit 1。

`--model` 指定审计模型。`--profile` 仅支持 Codex 和 OMP，用于选择本地隔离配置；Claude
Code 的 `--bare` 不加载本地 profile。`--run` 记录实际选择的客户端/模型/profile 作为
auditor，但**不强制**不同 preset：evidence 尚未记录 implementation preset，D3 仍是
操作员责任。选择审计客户端/模型时必须确保其与实现证据的 preset 不同。
每次 `--run` 都会端到端调用外部 agent CLI；大批量在慢模型上耗时以分钟计。runner 施加
墙钟超时，默认 60 分钟，可用 `URTEXT_AUDIT_TIMEOUT_MS`（正整数毫秒）覆盖；超时即拒绝本次
运行且不导入任何裁决。

### `urtext gate [--diff]`
基于风险分级、采用**叠加**谓词的裁决。每个可运行子句都需要
`evidence=pass ∧ meta-audit=agree ∧ not stale`；高风险子句*额外*
需要当前 HEAD 上的人工 `review --approve`；manual 子句则需要当前 HEAD 上的人工
`decide --pass`，而不是可运行证据（且不需要
元审计(meta-audit)）。其他所有情况都会路由给人。`--diff` 也会计入未映射
改动。任何子句需要人时都会 **Exit 1**。*v0 caveat:* gate 按子句 id
匹配证据，而不是按修订匹配，所以先 `verify` 再 `gate`（见[裁决
门](../mechanisms/06-meta-audit-gate.md)）。

```text
overall: human
  · 39 clause(s) require human adjudication
```

## 人工决策（账本）

### `urtext review <spec-path>#<clause-id> --approve|--reject [--brief <hash>] [note…]`
记录高风险子句（不安全通道(unsafe lane)）的人工代码评审。绑定当前 HEAD sha；
如果 HEAD 移动，评审就会失效，必须重做。**批准要求 worktree 洁净且携带当前
brief-hash**（来自 `urtext brief`）：未提交编辑或缺失/过期哈希都会 fail-closed
（`dirty_worktree` / `brief_required` / `brief_stale`）。拒绝方向不需要——
它是保守方向。拒绝未知或非高风险子句，或 git failure。持久化到 `reviews` 表
（历史经 `urtext brief` 读回）。

### `urtext decide <spec-path>#<clause-id> --pass|--fail [--brief <hash>] [note…]`
记录 `manual`-oracle 子句的人工决策。也会绑定 HEAD sha，
并落入 `decisions` 账本。**通过 `risk:high` 的 manual 子句要求 worktree 洁净
且携带当前 brief-hash**，与批准相同；`--fail` 和低风险决策不需要。
拒绝未知或非 manual 子句，或 git failure。

### `urtext decisions`
列出 Decision 账本，最新的在前。

```text
$ urtext decisions
No decisions recorded.
```

### `urtext ui [--port <n>] [--no-open]`
打开本地操作台。在 `127.0.0.1` 启动**临时**前台服务（随机端口，或由
`--port` 指定），自动打开浏览器（`--no-open` 可关闭），并阻塞到 Ctrl-C。
console-family 拆为四页：`/` 是人工队列和工作区摘要，`/agent` 是 Agent 队列
与 audit 控件，`/specs` 浏览全部 live clause，`/decisions` 浏览当前 HEAD 已裁决
的 manual clause。每个列表独立使用 `?page=N`，第 1 页省略 query。
`URTEXT_UI_PAGE_SIZE` 配置正整数服务器页大小（默认 20）；它是服务器/UI 内部
配置，不属于包的公共 `UiRenderConfig` API。

四页都显示 workspace 级 unmapped 状态。紧凑提示指回 `/`；精确的 `urtext map`
与 `urtext ack` 修复命令只在对应的分页人工队列行出现一次。检测失败始终是可见
错误，不会伪装成空的 all-clear。所有 clause 项都链接 `/brief`；All Specs 页也
包含未进入任一队列的 clause。brief 保留 `urtext brief` 的原文，并展示风险、
证据新鲜度、映射代码、依赖影响和真实映射范围 Git diff。

待裁决 manual clause 提供 pass/fail 按钮，浏览器先取得当前 brief-hash，再走与
CLI 相同的 `recordDecision` 守卫；pass 还必须提供一句落账理由。高风险代码评审
仍在 `/brief`，沿用 clean-worktree、brief-hash 和 HEAD 守卫。audit 表单在
`/agent` 恒存在；没有可审计项时按钮禁用并显示明确空态。UI 不启动嵌套
`urtext` 进程，也不解析 CLI 展示文本。

每页都有 skip link、`<header>`、`<nav aria-label="页面导航">` 和唯一 `<main>`；
守卫动作是带 label 与 `aria-live` 输出的内联表单，不调用 `prompt()`/`alert()`。
Code Blame Diff 可折叠：高风险或短 diff 默认展开
（`URTEXT_UI_DIFF_OPEN_MAX_LINES`，默认 80），显示超过
`URTEXT_UI_DIFF_DISPLAY_MAX_LINES`（默认 2000）即截断。三个环境变量都必须是
正整数，否则服务启动即 fail-fast。全部路由校验 loopback `Host`；写路由额外
校验会话 CSRF、同源、精确 JSON content-type 和请求体上限。样式为单一内联
light/dark、reduced-motion 样式表，无框架、外部资源或网络请求。该进程不是
daemon；Ctrl-C 时 Exit 0。

## 退出码摘要

这张表是工作指南，不是穷尽规范（`src/cli.ts` 中的 CLI 才是
权威）：

| Command | Exit 1 when |
|---|---|
| `check` | building 修订、未知 ref；`--diff` 还包括：未映射改动 |
| `verify` | oracle 运行前出现校验/链接错误，或任何子句 oracle 失败 |
| `status` | 任一车道存在待办 |
| `brief` | 目标错误，或任一简报被拒绝（building/引用悬空修订、未知子句） |
| `impact` | 目标格式错误，或 FR 未声明/已 tombstone |
| `audit --import` | 当前覆盖包含 `disagree` |
| `gate` | 任何子句需要人 |
| `map` | 未知子句、参数错误、git failure，或范围没有与当前 `git diff` 重叠 |
| `ack` | 参数错误、git failure，或范围没有与当前 `git diff` 重叠 |
| `review` | 未知或非高风险子句、参数错误、git failure；`--approve` 还包括：worktree 脏、brief-hash 缺失/过期 |
| `decide` | 未知或非 manual 子句、参数错误、git failure；高风险 `--pass` 还包括：worktree 脏、brief-hash 缺失/过期 |

所有其他命令成功时 Exit 0。
