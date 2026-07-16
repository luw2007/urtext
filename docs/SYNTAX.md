# Urtext 语法（v0）

> 状态：定稿 v0。实现以本文为准；破坏性修改需在本文记录版本演进。
> 依据 VISION.md P1（无 oracle 即错误）、P6（markdown + anchor，不发明格式）。

## 文件布局

```text
specs/<feature>/
  spec.md        行为子句（clause 文件；除 tasks.md 外任意 *.md 均可含子句）
  tasks.md       验收 checklist（任务引用子句）
```

- 子句文件与 checklist 同目录构成一个 **feature 单元**；checklist 的 `clauses:`
  引用在本单元内解析。
- 跨文件引用使用 `refs:<workspace 相对路径>#<clause-id>`。

## 子句（clause）

一条子句 = 一个携带 `C\d+` id 的 markdown 标题 + 其后的正文（至下一个任意级标题为止）。

```markdown
## C001 优惠券不可叠加 <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:billing/spec.md#C003 -->
Given 已折扣商品 When 应用优惠券 Then 拒绝并返回 409
```

语法要点：

- 标题行匹配 `/^#{1,6}\s+(C\d+)\b\s*(.*)$/`。**不带 `C\d+` id 的标题是普通 prose**，
  不受任何约束——只有声明为子句的陈述才进入判定体系。
- 元数据置于 HTML 注释 anchor（`key:value`，空格分隔，值内不得含空格），
  可见文本保持干净 GFM。

### anchor 字段

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `oracle` | **是** | `<kind>` 或 `<kind>:<ref>` | 见下表。**缺失即 `missing_oracle` 错误**（P1） |
| `risk` | 否 | `low`（默认）\| `high` | `high` ⇒ 物化任务强制 human gate + 代码级人工审查（unsafe 语义） |
| `refs` | 否 | 逗号分隔的 `path#Cid` | 跨 spec 依赖；linker 据此建图与 stale 传播 |

### oracle 五种

| kind | ref 形态 | 判定 |
|---|---|---|
| `test` | 测试文件/pattern | 测试通过 |
| `cmd` | shell 命令（无空格限制下用 `%20` 转义或包装脚本） | 退出码 0 |
| `metric` | `探针表达式`（如 `p99<200ms`） | 数值比较 |
| `diff-scope` | 允许触碰的路径 glob | 违例文件集为空 |
| `manual` | 可省略；或人工检查项说明 | 人工勾选，落决策记录。**占比是健康度指标**（P9） |

## Checklist（tasks.md）

GFM 任务列表 + anchor 元数据，`clauses` 为多值字段：

```markdown
- [ ] T001 实现叠加校验 <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->
    在 apply 路径上拒绝已折扣商品。
    第二行 prompt，与上一行以换行连接。
```

- 一行一个任务：`- [ ] T\d+ Title <!-- … -->`；缩进 prose 为该任务的 prompt。
- `T00x` 是文件内稳定 id；`depends` 引用同文件 `T00x`。
- **无 id 的 checkbox 行是 `missing_file_id` 错误**（fail-closed）。
- `clauses:` 引用同 feature 单元内的子句 id；未解析即 `unknown_clause` 错误。
- `gate:true` ⇒ 任务完成前需人工批准（waiting_human 语义）。

### anchor 字段

| 字段 | 取值 |
|---|---|
| `role` | 执行角色提示（coder/reviewer/…），自由字符串 |
| `depends` | 逗号分隔 `T00x` |
| `gate` | `true` 开启 human gate |
| `clauses` | 逗号分隔 `C\d+`，本任务声称满足的子句 |

## 错误目录（fail-closed）

解析或校验产生任一错误时，该文件的修订停在 `building`，永不进入可执行状态。

| code | 含义 |
|---|---|
| `missing_oracle` | 子句缺 oracle 绑定 |
| `invalid_oracle_kind` | oracle kind 不在五种之内 |
| `invalid_risk` | risk 不是 low/high |
| `duplicate_clause_id` | 子句 id 在文件内重复 |
| `malformed_anchor` | anchor token 不是 key:value |
| `missing_file_id` | checkbox 行缺 `T00x` id |
| `duplicate_file_id` | 任务 id 重复 |
| `self_dependency` / `unknown_dependency` | 任务依赖闭包不成立 |
| `unknown_clause` | 任务引用的子句在 feature 单元内不存在 |
| `unknown_ref` | 子句 `refs` 指向不存在的文件或 id（check 阶段校验） |

## 注册表（registry）

`urtext index` 将扫描结果 reconcile 进 `.urtext/registry.sqlite`，
采用不可变修订链语义：

- 每文件一条修订链：`(spec_path, revision)`，`content_hash = sha256:<hex>`。
- 内容未变 → no-op；变更 → 追加新修订（`ready` 或 `building`）。
- 文件删除 → 追加 `tombstoned` 修订（content_hash NULL），**从不改写历史修订**。
- 每条子句另记 `text_hash = sha256(标题 + 正文)`：anchor 元数据变更不算文本变更。
- `refs` 边落 `clause_refs` 表（随修订链版本化）；linker 在每次 scan 后对
  **全 workspace 最新活跃修订**解析引用（`unknown_ref` 属 check 阶段错误，
  不改单文件修订状态——目标被删而引用方未变的悬空引用只有全量校验能捕获）。
- 上游子句 text_hash 变更 → 反向闭包内依赖子句的既有证据打 `invalidated_at`
  （evidence 唯一可变列；作废不删除）。

## v0 边界（后续版本处理）

- anchor 值不含空格（whitespace 分词，v1 再评估引号转义）。
- 设计稿引用（Figma）、demo 快照、visual/interaction oracle：VISION P7 范畴，v1 扩展
  `oracle` kind 与 `refs` 目标类型，不改本文既有语法。
- DWARF 映射（clause↔code）不在 v0 语法内，注册表 schema 已为其预留修订链。
