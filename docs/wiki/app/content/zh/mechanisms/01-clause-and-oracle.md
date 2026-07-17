# 子句(clause)与 oracle(判据)

语言层恰好只有四个原语：**子句(clause)**、**oracle(判据)**、**refs(引用)**，
以及 **risk(风险级别)**。Urtext 中的其他一切都建立在它们之上。本页是
v0 语法的权威导览；形式化参考见
[`docs/SYNTAX.md`](../../SYNTAX.md)。

首次出现时以 `英文(中文)` 标注术语，其后沿用英文原词以保持与语法 token 一致：
**oracle(判据)** 是裁决一条子句通过与否的客观检查，**refs(引用)** 声明子句间的依赖，
**risk(风险级别)** 是决定是否强制人工复审的二元分级。

## 子句是带 id 的标题

子句是一个携带 `C<n>` id 的 Markdown 标题，后面跟着它的正文（直到
下一个任意级别的标题）。元数据放在 HTML 注释锚点中，因此
可见文本保持干净的 GFM。

```markdown
## C001 Coupons must not stack <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:specs/billing/spec.md#C003 -->
Given an already-discounted item, When a coupon is applied, Then reject with 409.
```

两条规则承担全部工作：

- 标题匹配 `^#{1,6}\s+(C\d+)\b\s*(.*)$`。**没有 `C\d+`
  id 的标题只是普通正文** — 不受任何绑定，也不被任何东西检查。只有一条陈述
  被你有意提升为子句时，才会进入判断系统。
- 锚点元数据是 `key:value`，用空格分隔，并且**值不能包含
  空格**（这是 v0 边界）。可见标题保持可读。

一个 `refs` 值是工作区相对路径加 `#Cid`，按字面匹配，不做
路径规范化 — 因此它必须从工作区根目录写起，例如
`specs/billing/spec.md#C003`，而不是 `billing/spec.md#C003`。

## 锚点字段(anchor fields)

| 字段 | 必填 | 取值 | 含义 |
|---|---|---|---|
| `oracle` | **yes** | `<kind>` 或 `<kind>:<ref>` | 检查。**缺失 → `missing_oracle` 错误** |
| `risk` | no | `low`（默认）\| `high` | `high` 会在裁决门中强制人工代码评审 |
| `refs` | no | 逗号分隔的 `path#Cid` | 跨规范依赖；链接器基于这些构建图 |

`risk` 是单一二元分级 — `low` 或 `high`，没有更细粒度。更广义的
风险概念作为多维成本模型（延迟、爆炸半径、
可逆性）是风险分级背后的设计原则（[assembly-to-C 条件
5](../concepts/02-assembly-to-c.md)），不是 v0 存储的额外字段。

## 五种 oracle(判据)

| 种类 | 引用形态 | 判定结果 | v0 状态 |
|---|---|---|---|
| `test` | 测试文件或模式 | `npx vitest run <ref>` 退出 0 | 可执行 |
| `cmd` | 可执行文件 + 以 `%20` 分隔的字面参数 | 进程退出 0 | 可执行 |
| `diff-scope` | 改动可触及的路径 glob | 没有*已跟踪*的改动文件落在范围外 | 可执行 |
| `manual` | 可选；人工检查描述 | 从不运行 → 始终为 `pending` | 不可执行 |
| `metric` | 探针表达式（例如 `p99<200ms`） | — | **不支持；明确失败** |

语法容易诱导你误读两个精确点：

- **`cmd` 不是 shell。** 它用无 shell 的 `spawnSync(command, args)` 运行，所以
  管道、重定向、`&&`、globbing 和变量展开都**不会**工作。
  ref 是一个可执行文件加按 `%20` 拆分的字面参数。若需要真正的 shell
  语法，请让 `cmd` 指向一个包装脚本。
- **`metric` 已声明，但在 v0 中不可判定。** 解析器接受它，但
  runner 会返回 `fail`，并带有 "metric oracles are not supported in v0." 它是 v1
  功能 — 未实现的检查绝不能看起来是绿色通过，所以它会大声失败，
  而不是跳过。

还有 `diff-scope` 的一个细节：它检查 `git diff --name-only HEAD`，该命令
只列出**已跟踪**改动。一个新的、未跟踪的越界文件对
它不可见，在被添加前不会触发该 oracle。

## 检查清单将任务绑定到子句

同一 feature 目录中的兄弟文件 `tasks.md` 承载验收
检查清单。它是使用同一锚点约定的 GFM 任务列表，并且 `clauses`
是一个多值字段：

```markdown
- [ ] T001 Implement the stacking guard <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->
    Reject an already-discounted item on the apply path.
```

- 每行一个任务：`- [ ] T\d+ Title <!-- … -->`；缩进正文就是该任务的
  prompt。
- **没有 `T\d+` id 的复选框行是 `missing_file_id` 错误**（失败关闭）。
- `clauses:` 必须解析到同一 feature 目录中声明的子句；
  无法解析的 id 是 `unknown_clause` 错误。
- `gate:true` 是**存储的元数据**，表示该任务应获得人工
  批准。在 v0 中它会被记录（`human_gate`），但**不会被强制执行** — 没有命令
  读取它来阻塞任务。请把它视为作者标记，而不是运行时锁。

## 失败关闭错误目录

当解析或验证产生任何错误时，该文件的修订会停在
`building`，永远不会变成可执行。没有部分接受。主要
代码如下：

| 代码 | 含义 |
|---|---|
| `missing_oracle` | 子句没有绑定 oracle |
| `invalid_oracle_kind` | oracle 种类不是五种之一 |
| `invalid_risk` | risk 既不是 `low` 也不是 `high` |
| `duplicate_clause_id` | 子句 id 在同一文件内重复 |
| `malformed_anchor` / `malformed_ref` | 锚点令牌不是 `key:value`，或 `refs` 值格式错误 |
| `missing_file_id` | 复选框行缺少 `T\d+` id |
| `duplicate_file_id` | 任务 id 重复 |
| `self_dependency` / `unknown_dependency` | 任务依赖闭包不成立 |
| `unknown_clause` / `malformed_clause_ref` | 任务引用了缺失或格式错误的子句 id |
| `unknown_ref` | 子句的 `refs` 指向缺失的文件或 id（在 `check` 时检查） |

权威目录存在于解析器（`src/clause-parser.ts`、
`src/task-parser.ts`）中；本表是一个工作子集。它的执行依据是 [P1 —
为什么规范必须可判定](../concepts/03-why-decidable.md)。子句一旦存在，
就需要一个跨修订存放的位置：[注册表](02-registry.md)。