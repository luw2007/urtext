# 元审计(meta-audit)与裁决门(gate)

客观证据(evidence)回答的是“oracle(判据) 通过了吗？”它不回答“oracle 是否
真的测试了正确的东西？”测试可以是绿色的但仍然作弊；
`diff-scope` glob 可以被钻空子；一个以零退出的 `cmd` 可以什么都没检查。最后
两个机制处理这些缺口：**元审计**会重新读取证据，而
**裁决门**会把人的注意力缩小到恰好需要它的地方。

## 元审计：对证据的第二次读取

Urtext 本身从不调用 LLM。相反，`urtext audit --export` 会输出一个 JSON
包（协议 `urtext-meta-audit/v0`）——针对每条已裁定的证据，包含
子句(clause)的含义、oracle 和客观输出。一个外部 agent
在进程外读取该包，并返回每条证据的 `agree` / `disagree`
裁决，然后由 `audit --import` 反馈回来。

*意图*（DECISIONS D3）是，审计器运行在与
实现者**不同的 preset** 上——Claude 实现时由 Codex 审计，反之亦然——这样
检查改变的是维度，而不只是模型。要说清楚这一点存在于哪里：

- **不同 preset 的要求是一种 operator 纪律，而不是被强制执行的
  属性。** `audit --import` 接受任何非空的 `auditor` 字符串，并且只
  检查证据 id 是否存在（`src/cli.ts`，`src/audit.ts`）。Urtext 会记录
  你给出的审计器名称；它不会验证审计器是不是不同的
  模型。在不同 preset 下运行审计是你的责任。
- **它读取证据，而不是重新运行实现。** 裁决绑定到一个
  具体的 `evidence_id`。失效和 pending 的证据不会被导出——没有
  可审计的东西。一个 v0 细节：该包按子句 id 把每条证据行与
  *最新 ready* 的子句文本和 oracle 配对，而不会匹配 revision——
  因此如果你在记录证据后编辑了子句，导出可能会在
  旧证据旁边显示更新的 prose。审计前请重新 `verify`，以保持它们
  对齐。

## 分歧按当前覆盖范围计数

`audit --import` 会在结果**覆盖范围**包含 `disagree` 时以非零退出。
覆盖范围基于*最新、非失效、非 pending* 的
证据计算，并取每个证据 id 的*最新*审计裁决（`src/audit.ts`）。实际
后果：

- 当前证据上的 `disagree` → `import` 退出 1。分歧绝不会被
  静默吞掉。
- 如果同一证据上的 `disagree` 已被后来的 `agree` 取代，
  或者它位于后来因失效传播而失效的证据上，则不计入——
  它已经不再是当前覆盖范围的一部分。

因此退出码反映的是“当前图景是否包含未解决的
分歧？”，而不是“是否曾经记录过任何分歧”。一个 v0 细节：
覆盖范围按子句 id 分组证据，而不会重新连接存活子句集合，所以
即便你后来*删除*了某条子句，针对它的 `disagree` 仍然可能让
`import` 保持红色，直到那条孤儿证据被失效。

## 裁决门：风险分级裁决

`urtext gate` 遍历每条存活子句，并逐条决定它是否可以
自动通过，或必须交给人。谓词是**累加的**——一条子句
只有在适用于它的*所有*条件都成立时才会自动通过（`src/gate.ts`）：

- **每条可运行子句**都需要 `evidence=pass`、`not stale`，以及元审计
  `agree`（既不是 `disagree` 也不是 `unaudited`）。这也适用于高风险可运行
  子句——它们并不豁免于审计要求。
- **高风险子句**还需要当前 HEAD 上的人类代码评审 `approve`
  （[不安全通道(unsafe lane)](07-unsafe-lane.md)）。仅靠证据永远不能放行
  它。
- **manual 子句**（始终是 `pending`）需要当前 HEAD 上的人类 `pass` 决策，
  用它代替可运行证据，并且**不需要**元审计——它的
  事实真相就是人类决策。

其他所有情况——缺失证据、失败、没有决策的 `pending`、一个
`disagree`、`unaudited`（对任何可运行子句）、失效，或高风险子句上被拒绝/缺失的
评审——都会带着理由路由给人。`gate
--diff` 还会把未映射改动折叠进整体裁决。**只要有任何
子句需要人，整个裁决门就需要人**，并以非零退出。

> **v0 限制——证据按子句 id 匹配，而不是按 revision。** 裁决门
> 会把每条存活子句与其按 `(spec_path,
> clause_id)` 找到的*最新*证据行配对，而不会检查该证据是否针对当前
> revision 产生（`src/gate.ts`）。因此如果你编辑了子句的 oracle 但尚未重新运行
> `verify`，裁决门仍可能读取*上一*个 revision 的绿色证据。它
> 也会裁决当前 revision 为 `building` 的子句。始终先 `verify`
> 再 `gate`；不要把失效证据的自动通过当作新的通过。这
> 是已知的 v0 缺口，而不是预期行为。

针对本仓库的一次真实运行，发生在开发中途：

```text
$ urtext gate
  ...
  ⊗ C014 记忆层：manual 子句人工裁决落 Decision ledger [high] → human
      · high-risk: needs human code review — `urtext review` (P5)
      · no meta-audit verdict

overall: human
  · 39 clause(s) require human adjudication
```

每个 `⊗` 都携带它的理由。没有任何东西被藏在摘要分数后面。

## 这如何改变“人在环中”

这场争论通常被表述为“人是否应该在环中？”裁决门
重新框定了它：**人始终是最终权威，但机器决定
*什么会触发*他们。** 低风险、绿色、已同意、非失效的子句会
自动通过。人的注意力收敛到高风险和有争议的部分——这
是[核心赌注](../concepts/03-why-decidable.md)能够在规模上成立的唯一方式。这个
收敛中风险最高的一片有自己的工作流：
[不安全通道](07-unsafe-lane.md)。
