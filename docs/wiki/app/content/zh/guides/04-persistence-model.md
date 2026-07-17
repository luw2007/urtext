# 持久化模型

Spec Kit 在它的 [规范持久化
模型](https://github.github.com/spec-kit/concepts/spec-persistence.html)中提出了一个尖锐问题：需求变更后，
`spec.md`、`plan.md` 和 `tasks.md` 会怎样？它
给出了三种答案——flow-back、flow-forward、living spec——并谨慎地说
这个选择是**“团队约定，而不是 CLI 设置。”**

Urtext 对同一个问题给出不同答案：它把约定变成
机制。

## 两个问题，重新表述

Spec Kit 把一个时间问题（“规范应该有多久的效力？”）和一个
变更问题（“当需求变化时，artifact 集合会怎样？”）分开。
Urtext 对二者的立场：

- **时间性。** 规范是真相来源，并且比实现活得更久——
  位于从*规范锚定*到*规范即源头*这一光谱的后端。代码是
  你重新生成的投影，而不是需要你手工维护的同等 artifact。
- **变更。** 已完成的修订(revision)是不可变历史，但变更会
  沿引用图*传播*，而不是 fork 出一个新目录。这是
  对 Spec Kit 三种模型中两种模型的有意融合。

## Urtext 落在三种模型的哪里

| Spec Kit 模型 | 它的规则 | Urtext 的关系 |
|---|---|---|
| **Flow-back** | 编辑任何 artifact，手动调和 | *拒绝。* 手动调和正是 Urtext 存在所要防止的静默漂移失败 |
| **Flow-forward** | 冻结已完成 artifact；为新需求建立新目录 | *在存储层采用。* [注册表(registry)](../mechanisms/02-registry.md) 永不重写历史修订——它只追加 |
| **Living spec** | 先编辑 `spec.md`；重新生成派生 artifact | *在传播层采用。* 改动一个子句(clause)，[失效传播](../mechanisms/04-linker-impact.md)会使依赖证据(evidence)失效 |

Urtext 在**存储方式上是 flow-forward**（不可变修订链、
只追加证据），在**传播方式上是 living**（一次 `text_hash` 变化
会把失效状态涟漪式传播过反向闭包）。你得到 flow-forward 的
审计轨迹，却没有它的重复问题；也得到 living spec 的一致性，
却不会丢失历史。（删除时墓碑修订存在于 schema 中，
但尚未接入 scanner——在 v0 中，删除文件会让其最后一个
修订继续存活；见 [registry](../mechanisms/02-registry.md)。）

## 决定性差异：强制执行

每一种 Spec Kit 模型都有一个共同属性——它是团队约定要
遵守的惯例，并且当他们不遵守时有命名的失败模式（静默漂移、重复
上下文、丢失理由）。Urtext 移除了对约定的依赖：

- **你不能悄悄编辑*已跟踪*代码却跳过规范。** `urtext check
  --diff` 会标记未映射 hunk 并以非零退出
  （[强制执行](../concepts/05-source-of-truth-flip.md)）——但 v0 对
  全新未跟踪文件有盲点。
- **你不能让下游证据继续保有失效的绿色标记。** 改变
  子句的*文本*会自动作废依赖证据（仅改锚点不会——
  见 [registry](../mechanisms/02-registry.md)）。
- **你不能针对未改动文件伪造 spec→code 链接。**
  声明的范围必须与真实的 `git diff` hunk 相交
  （[DWARF](../mechanisms/05-dwarf-mapping.md)）；这证明文件中确有某些东西
  发生了变化，而不是证明整个范围都变了，或它满足该子句。

Spec Kit 说得对：时间立场的*选择*是团队决策——而
Urtext 明确做出了这个选择（spec-as-source）。但*让 artifact
诚实地符合这个选择*并不留给纪律。这是 Urtext
拒绝变成可选项的一件事。

## 实践中这意味着什么

你不会在 Urtext 里选择持久化模型——registry 和链接器(linker)
已经实现了一个。你的工作更窄，也更诚实：**当你改变意图时，
改变子句，然后让机制告诉你哪些东西失效。** 当你在不改变意图的情况下
改动代码，裁决门(gate)会让你要么把它 flow back，要么承认它。
约定不再是需要记住的东西；它是
工具强制执行的东西。
