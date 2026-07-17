# Urtext

[English](README.md) | 简体中文

> **你的系统的 ur-text。代码只是其一种解释。**

在古典音乐出版中，*Urtext* 版本会剥离一代代编辑改动，恢复作曲家的原始意图——每一次演奏都要回应的唯一权威来源。

Urtext 将同样的纪律应用于用 AI 编码 agent 构建的软件：

- **人类维护系统意图**——规范、设计、交互演示、验收清单。
- **AI 维护投影**——代码。
- **每条规范性陈述都绑定一个 oracle**——一个可执行的检查，以证据判定意图是否仍然成立。
- **未映射的改动必须回流**——不对应任何规范子句的代码改动会被显式暴露，绝不悄然吸收。

## 快速开始

```bash
npm install -g urtext
cd your-repo
mkdir -p specs/coupon
```

将意图声明为子句（`specs/coupon/spec.md`）——子句是带 `C<n>` ID 的标题，并且**每个子句都必须绑定一个 oracle**：

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

将验收任务绑定到子句（`specs/coupon/tasks.md`）：

```markdown
- [ ] T001 Implement stacking guard <!-- role:coder gate:true clauses:C001 -->
    Reject on the apply path.
```

先验证，再运行 oracle 并记录证据：

```bash
urtext check   # 任一子句缺少 oracle、任一引用悬空等情况时以退出码 1 结束
```

```bash
urtext verify  # 任一子句的 oracle 失败时以退出码 1 结束；证据写入 .urtext/registry.sqlite
```

无法被检查的规范性陈述是编写错误，而不是一种更柔性的真相。原则见 [docs/zh-CN/VISION.md](docs/zh-CN/VISION.md)，七个子系统见 [docs/zh-CN/DESIGN.md](docs/zh-CN/DESIGN.md)，v0 语法见 [docs/zh-CN/SYNTAX.md](docs/zh-CN/SYNTAX.md)。

## 文档

[文档 Wiki](docs/zh-CN/wiki/index.md) 分为三层：**概念**（为什么可判定规范是一场范式转变）、**机制**（循环如何闭合）与**指南**（如何投入使用）。从[快速开始](docs/zh-CN/wiki/guides/01-quickstart.md)开始，或阅读 [Urtext 与规范驱动开发](docs/zh-CN/wiki/concepts/04-vs-spec-driven-dev.md)，了解它与 Spec Kit 及同类工具的区别。

中文权威文档目录见 [docs/zh-CN/README.md](docs/zh-CN/README.md)。

## 状态

当前 v0 交付状态与实现边界见[中文 Wiki 状态页](docs/zh-CN/wiki/index.md#状态)。

## 许可证

MIT
