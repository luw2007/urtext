# 快速开始

十分钟写下你的第一个子句(clause)。目标不是为整个系统编写规范——而是
拿出*一个*真实需求，让它可判定，并看着闭环完成。

## 安装

```bash
npm install -g urtext
```

Urtext 原生基于 git 且无服务器：没有守护进程、没有服务器、无需创建 workspace，
也没有需要学习的编排模型。它确实需要 Node.js 22+ 和 npm 包
（该包会拉取原生 `better-sqlite3`）。你从已有的仓库
开始。

## 1. 将意图声明为子句

从你正在构建的任何东西里挑一个真实需求。创建一个 feature
目录，并把它写成子句——一个带有 `C<n>` id 的标题，而且**每个
子句都必须绑定一个 oracle(判据)**：

```bash
cd your-repo
mkdir -p specs/coupon
```

```markdown
<!-- specs/coupon/spec.md -->
# Coupon rules

Descriptive prose is free — write whatever context you like here. Only headings
carrying a C-id become clauses.

## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

oracle 指向一个尚不存在的测试。没关系——这正是重点。
子句是一项可判定的承诺；测试就是它被判定的方式。

## 2. 绑定一个验收任务

```markdown
<!-- specs/coupon/tasks.md -->
- [ ] T001 Implement the stacking guard <!-- role:coder gate:true clauses:C001 -->
    Reject an already-discounted item on the apply path.
```

## 3. 检查语法

```bash
urtext check
```

`check` 会索引你的规范，并以 fail-closed 方式处理错误。如果 C001 没有 oracle，你会看到
`missing_oracle` 错误，文件会停在 `building`——它根本
无法运行。无法被检查的规范性陈述是写作错误，现在暴露出来，
而不是以后才发现。

## 4. 验证：运行 oracle，记录证据(evidence)

编写该子句点名的测试（`tests/coupon-stack.test.ts`），实现这道防护，
然后：

```bash
urtext verify
```

`verify` 会运行每个子句的 oracle，并把只追加证据记录到
`.urtext/registry.sqlite`。任一子句失败都会以非零退出。当 C001 的
测试通过时，你会得到类似这样的行：

```text
  ✓ C001 Coupons must not stack [high] (test, pass)

1 pass, 0 fail, 0 pending — pass rate 100%, manual share 0%
```

这个绿色标记不是 AI 觉得你的代码看起来正确的意见。它是一个 oracle
实际运行并以零退出——说明该意图成立的客观证据。

## 你刚刚证明了什么

在四条命令里，你闭合了本文档其余部分所解释的循环：

- 该子句是**可判定**的——它绑定了 oracle，否则 `check` 就会拒绝
  它（[原因](../concepts/03-why-decidable.md)）。
- 完成是**证据，而不是分数**——`pass rate` 是绿色可运行子句
  除以已判定的可运行子句（[验证器(verifier)](../mechanisms/03-verifier.md)）。
- 因为 C001 是 `risk:high`，它的绿色证据仍然**不会**自动通过
  [裁决门(gate)](../mechanisms/06-meta-audit-gate.md)——它会路由到人工代码评审
  （[不安全通道(unsafe lane)](../mechanisms/07-unsafe-lane.md)）。

## 下一步

- 写好更多子句：[编写子句](02-authoring-clauses.md)。
- 学习每条命令：[命令参考](03-command-reference.md)。
- 理解何时*不*该使用 Urtext：[采用与
  边界](05-adoption-and-limits.md)。
