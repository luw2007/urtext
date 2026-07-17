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

### `urtext verify`
先 index 和 check，再运行每个子句的 oracle，并记录只追加证据(evidence)。
校验或链接错误（在任何 oracle 运行之前）*或者*任何失败的
子句 oracle 都会 **Exit 1**。报告 pass-rate 和 manual-share：

```text
34 pass, 0 fail, 5 pending — pass rate 100%, manual share 13%
```

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

### `urtext audit --export | --import <file>`
跨模型元验证协议。`--export` 会写出
证据覆盖包（`urtext-meta-audit/v0`），供你在不同 preset 上运行的审计者使用
（不同 preset 的要求是操作员纪律——import 接受任何 `auditor` 名称）。
`--import` 会读回它的 `agree`/`disagree` 裁决。若由最新的
非失效、非 pending 证据上的最新裁决构成的当前覆盖包含 `disagree`，
则 **Exit 1**。被后来的 `agree` 取代的 disagree，或作用在已失效证据上的
不计入。

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

### `urtext review <spec-path>#<clause-id> --approve|--reject [note…]`
记录高风险子句（不安全通道(unsafe lane)）的人工代码评审。绑定当前 HEAD sha；
如果 HEAD 移动，评审就会失效，必须重做。拒绝未知或非高风险子句，
或 git failure。持久化到 `reviews` 表
（v0 中没有 CLI readback——gate 会消费它）。

### `urtext decide <spec-path>#<clause-id> --pass|--fail [note…]`
记录 `manual`-oracle 子句的人工决策。也会绑定 HEAD sha，
并落入 `decisions` 账本。拒绝未知或非 manual 子句，或 git
failure。

### `urtext decisions`
列出 Decision 账本，最新的在前。

```text
$ urtext decisions
No decisions recorded.
```

## 退出码摘要

这张表是工作指南，不是穷尽规范（`src/cli.ts` 中的 CLI 才是
权威）：

| Command | Exit 1 when |
|---|---|
| `check` | building 修订、未知 ref；`--diff` 还包括：未映射改动 |
| `verify` | oracle 运行前出现校验/链接错误，或任何子句 oracle 失败 |
| `audit --import` | 当前覆盖包含 `disagree` |
| `gate` | 任何子句需要人 |
| `map` | 未知子句、参数错误、git failure，或范围没有与当前 `git diff` 重叠 |
| `ack` | 参数错误、git failure，或范围没有与当前 `git diff` 重叠 |
| `review` | 未知或非高风险子句、参数错误，或 git failure |
| `decide` | 未知或非 manual 子句、参数错误，或 git failure |

所有其他命令成功时 Exit 0。
