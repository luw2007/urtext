# 链接器(linker)

改动一个子句(clause)，然后问：*这还会触及什么？* 每个现有的
规范驱动工具都会让人阅读文档，或让 LLM 猜测，来回答这个问题。
Urtext 则从图中机械地回答它。

## 引用图

子句声明的每条 `refs` 边都会成为图中的一条边，存储在
`clause_refs` 表中，并随[注册表(registry)](02-registry.md)的修订链版本化。
`urtext impact` 反向遍历该图 — 一个子句的*反向闭包* —
并列出如果它改变会受到影响的每个子句和任务。

下面是针对本仓库自托管规范的一次真实运行：

```text
$ urtext impact specs/urtext/spec.md#C004
Affected clauses (reverse closure):
  specs/urtext/spec.md#C008
  specs/urtext/spec.md#C011
  specs/urtext/spec.md#C012
  specs/urtext/spec.md#C013
  specs/urtext/spec.md#C014
Affected tasks:
  specs/urtext/tasks.md T003 oracle runner 与证据库 (cites C004)
  specs/urtext/tasks.md T004 linker 与影响分析 (cites C008)
  specs/urtext/tasks.md T006 元验证协议与风险分级裁决门 (cites C011)
  specs/urtext/tasks.md T007 unsafe lane：高危子句人工代码审查工作流 (cites C013)
  specs/urtext/tasks.md T008 记忆层：manual 子句 Decision ledger (cites C014)
```

这就是触碰 C004（oracle runner 子句）的影响：五个下游
子句以传递方式依赖它，每个子句还携带引用它们的任务。
没有人阅读任何东西。图知道答案。

## 陈旧传播会让证据(evidence)失效

图不只是用于查询 — 它还驱动失效。当一个子句的
`text_hash` 改变（其标题或正文文本 — 不是它的锚点元数据，所以
`oracle`/`risk`/`refs` 编辑不会触发它）时，链接器会遍历*反向
闭包*，并把每个依赖子句标记为 `stale`。每个陈旧子句的现有
证据都会被盖上 `invalidated_at`。

这是对*迭代期间漂移*的具体回答。在传统 SDD 中，你
改动一个上游需求，下游证据会静静保留旧的
绿色标记 — 它看起来已验证，但回答的是一个已经不存在的问题。
Urtext 拒绝这种情况：改变 C004 的含义，所有
依赖 C004 的证据都会自动作废，直到重新验证。绿色会在
其前提移动的瞬间被撤回。

## 悬空引用失败关闭

引用可能在引用文件完全没有变化的情况下断裂 — 从文件 B 删除
`C003`，文件 A 的 `refs:B#C003` 就突然指向空处。
因为链接器会根据**整个工作区最新的活动修订**解析引用，
这个悬空引用会作为 `unknown_ref` 在 `check` 时被捕获，
并且命令以非零退出。一个让边静默悬空的引用图
还不如没有。

## 为什么这是突出的能力

影响分析是 Urtext 做到而现有规范工具完全没有做到的
一件事。Spec Kit 的变更管理会运行它的 `analyze` 命令，这是一个由 LLM 驱动的
只读遍历，读取当前的 `spec.md` / `plan.md` / `tasks.md`；Urtext 的答案
是一次图遍历，结果确定。
*改变一个子句，并得到“这会涟漪到什么”的机械答案* —
这是链接器交付的独立价值，也是
把失败归因回意图的前提，也就是 [DWARF
映射](05-dwarf-mapping.md)。