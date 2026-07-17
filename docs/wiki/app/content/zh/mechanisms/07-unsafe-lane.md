# 不安全通道(unsafe lane)

有些路径无法完全由规范承载。安全边界、数据
迁移、并发、资金路径、不可逆删除——在这些地方，
规范总会遗漏语义，而**代码仍然是唯一
可评审的事实。** Urtext 不会假装不是这样，就像 C 从未
假装 `inline asm` 不存在一样。这是[原则
P5](../concepts/02-assembly-to-c.md)，而不安全通道就是它的工作流。

## 绿色证据(evidence)对高风险来说还不够

一条 `risk:high` 子句(clause)即使所有证据都是绿色的，也**不会**自动通过。
[裁决门(gate)](06-meta-audit-gate.md)会基于原则拒绝它：通过的测试证明
实现与规范措辞自洽，但在危险
路径上，这恰恰还不够。人必须查看代码。

`urtext review <spec>#<clause> --approve|--reject [note]` 会记录这次人类
代码级评审：

```text
$ urtext review specs/payment/spec.md#C001 --approve reviewed refund path
approved specs/payment/spec.md#C001 @ 3f2a1c0 by luw2007
```

## 评审绑定到一个 commit

批准不是永久祝福。它绑定到**评审当下的 HEAD sha**，
记录在 `reviews(spec_path, clause_id, commit_sha, decision,
reviewer, note)` 中。如果 HEAD 移动，评审就会失效，子句必须
再次评审。

要精确说明该绑定覆盖什么：它记录 `git rev-parse HEAD`，
而不记录工作树的任何内容。因此评审锚定到**已提交的
基线**，而不是未提交编辑的快照。提交新工作会移动 HEAD
并使评审失效——但批准之后进行的未提交编辑会让 HEAD
保持不变，因此*不会*使它失效。保证是“这次批准是
针对 commit X 作出的”，而不是“被评审的精确字节就是将发布的精确字节”。
裁决门只有在看到当前 HEAD 上有 `approve`，并且
其他所有条件都成立时，才会放行高风险子句；`reject` 或缺失评审
都会让它保持 `human`。

## 两本账本，一层记忆

评审不是短暂的控制台输出——它们会持久化在 `reviews` 表中。
`manual` 子句的人类裁决也是如此，由 `urtext decide
<spec>#<clause> --pass|--fail` 记录到一个**单独的** `decisions` 表中，也绑定到
HEAD sha。两者是不同的账本，只有 decisions 账本有
CLI 回读：

```text
$ urtext decisions
No decisions recorded.
```

（这里为空，因为本仓库的高风险子句由 `test`
oracles 证明，而它的 `manual` 子句没有常设人类决策。）`urtext
decisions` 只列出 decisions 表；v0 中没有列出 `reviews` 的命令
——评审由裁决门消费，而不是用来浏览。这两张表共同构成了
Urtext 记忆层的种子：人类判断进入系统的每个地方，
其裁决、行动者、HEAD sha 和时间戳都会被保留——再加上理由，当
评审者提供理由时（note 是可选的）。

## 为什么危险路径不是死锁

在不安全通道之前，一个拥有绿色证据的高风险子句会卡住：
系统不会自动通过它，但又没有工作流推动它前进。这个
通道在不削弱原则的情况下解决了这一点。危险路径不会被
自动批准，也不会陷入死锁——它会通过一次*可追踪的*人类
评审，并绑定到作出该评审时所针对的已提交 HEAD 基线。这就是
[从汇编到 C 的类比](../concepts/02-assembly-to-c.md)所要求的逃生
舱口：一个被标记的、
一等位置，抽象在这里退到一边，代码被
直接评审，而不是让整个系统在 5% 的行为拒绝被
规范化时崩塌。
