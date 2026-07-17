# 规划：Urtext 理念与机制宣传 Wiki（docs 站点）

> 计划文件：docs/plans/urtext-20260717-docs-wiki.md
> 配套源：docs/VISION.md（原则）、DESIGN.md（结构）、SYNTAX.md（语法）、
> DECISIONS.md（结论存档）、ROADMAP.md（里程碑）、BRIEF*.md（判断书）、
> specs/urtext/（自举子句）、src/*.ts（真实实现）。
> 参照对象：GitHub Spec Kit docs（concepts/sdd、concepts/spec-persistence、7commands）。
> 范围：**只做面向读者的 wiki 内容与站点骨架**，把已有 VISION/DESIGN/SYNTAX 的内部叙事
> 重组为「宣传理念 + 讲清机制」的对外文档。
> **非目标**：不改任何 src/ 实现、不改子句语义、不发明新机制、不做营销落地页设计。

## 一、为什么现在写这个 wiki

现状证据：
- 权威叙事已齐全但**面向作者自己**（VISION/DESIGN/BRIEF 是「给未来的自己的判断书」，见 BRIEF.md:4）。
- README 是唯一对外入口，只有 quick start + 状态，**没有讲清"为什么可判定 spec 是范式迁移"**。
- Spec Kit 有独立 concepts/ 站点分层讲 SDD 理念、persistence、命令链；Urtext 对标同赛道却**无同级对外文档**（D1 已论证同赛道，但潜在用户看不到差异）。
- ROADMAP 种子验证需要「10 分钟内写出第一条子句」的 design partner——**没有 onboarding 文档，价值链第一步就断**（BRIEF.md:74 粒度手艺不可转移风险）。

结论：wiki 不是锦上添花，是种子验证的**前置基础设施**。缺它，M1–M5a 的闭环无人能读懂。

## 二、目标（可验收）

1. 潜在用户读完「理念」层能在一句话内复述 Urtext 与 Spec Kit 的**本质差异**（可判定/执法 vs 约定）。
2. 读完「机制」层能不看源码答出：一条子句如何从 spec 走到 evidence 到 gate。
3. 读完「上手」层能在 10 分钟内为真实 feature 写出第一条带 oracle 的子句并跑通 verify（对齐 ROADMAP 种子门槛）。
4. 每个机制主题**引用真实 CLI 命令 + 真实子句 id**，不写悬空承诺（沿用 BRIEF 的「诚实标注可运行边界」纪律）。
5. 所有代码块命令可复制即跑（对本仓库自举单元有效），wiki 自身成为 dogfood 的展示窗。

## 三、内容架构（三层，对标 Spec Kit concepts/）

Spec Kit 分 `concepts/`（理念）+ `guides/`（操作）+ 命令参考。Urtext 沿用三层但**每层都比 Spec Kit 多一层"可判定证据"**：

```text
docs/wiki/
  index.md                      # 门面：一句话定位 + 三层导航 + 状态徽章
  concepts/                     # 理念层（为什么）
    01-paradigm-shift.md        # 范式迁移：手工→AI→Vibe→人不再 review 代码
    02-assembly-to-c.md         # 汇编→C 六条件类比（Urtext 的理论地基）
    03-why-decidable.md         # 为什么 spec 必须可判定（P1 分界线）
    04-vs-spec-driven-dev.md    # 与 Spec Kit / SDD 的关联与区别（本文核心差异化）
    05-source-of-truth-flip.md  # 事实源翻转：为什么靠执法不靠自觉（P3 vs persistence 三模型）
    06-metaphor.md              # 古典乐净本隐喻（D6，品牌叙事）
  mechanisms/                   # 机制层（怎么做）
    01-clause-and-oracle.md     # 子句 + 五种 oracle（语言层）
    02-registry.md              # 不可变修订链注册表
    03-verifier.md              # oracle 执行 → 证据 → 完成率
    04-linker-impact.md         # refs 图 + stale 传播 + impact
    05-dwarf-mapping.md         # clause↔code↔evidence + unmapped 执法
    06-meta-audit-gate.md       # 跨模型元验证 + 风险分级裁决门
    07-unsafe-lane.md           # 高危子句人工审查车道
  guides/                       # 上手层（跟着做）
    01-quickstart.md            # 10 分钟第一条子句（对齐种子门槛）
    02-authoring-clauses.md     # 子句粒度手艺指南（缓解 BRIEF 风险 #3）
    03-command-reference.md     # 12 个 CLI 命令完整参考（index…decisions）
    04-persistence-model.md     # Urtext 的持久化立场（回应 spec-persistence 三模型）
    05-adoption-and-limits.md   # 渐进采用 + P9 证伪条件 + 何时不该用 Urtext
```

## 四、每个主题讲什么（内容大纲 + 源锚点）

### 理念层 concepts/

| 文件 | 核心论点 | 源锚点 | 对标 Spec Kit |
|---|---|---|---|
| 01 范式迁移 | 工作对象从代码上移到系统认知；四载体平等 | VISION §1 | 对应 sdd.html「flips the script」，但强调 review 瓶颈 |
| 02 汇编→C 六条件 | 一次真抽象迁移的六个成立条件 + AI 时代对应物 | VISION §2 表 + DECISIONS D5 | Spec Kit **无**此理论层，纯差异化 |
| 03 为什么可判定 | 无 oracle 子句 = 错误；语言 vs 文档的分界线 | VISION P1 | 对应「specifications become executable」，但 Urtext 给出执法点 |
| 04 vs SDD | 关联 5 点 + 区别 8 点对照表（含本规划一/二节的差异分析） | DECISIONS D1/D7 + 本次三文档对比 | **直接引用** sdd.html/7commands，标明缺 oracle/linker/DWARF |
| 05 事实源翻转 | persistence 三模型是「团队约定」；Urtext 用注册表把 living-spec 升级为执法 | VISION P3 + DECISIONS D4 | **直接回应** spec-persistence.html「not a CLI setting」，这是最强标语 |
| 06 隐喻 | 净本/演绎/走调可判定/校勘记；指挥=人 乐手=AI | VISION §1 + DECISIONS D6 | Spec Kit 无叙事隐喻，品牌资产 |

### 机制层 mechanisms/（每篇 = 一个子系统，含真实命令 + 子句 id）

| 文件 | 讲清什么 | 真实锚点 |
|---|---|---|
| 01 子句+oracle | `C\d+` 标题语法、anchor 字段、五种 oracle 判定表、fail-closed 错误目录 | SYNTAX.md 全 + clause-parser.ts；示例用 README coupon C001 |
| 02 注册表 | 不可变修订链（unchanged/building/ready/tombstoned）、content_hash/text_hash 区分 | SYNTAX.md「注册表」节 + registry.ts；`urtext index` |
| 03 验证器 | index→取 ready→跑 oracle→证据落库→pass-rate + manual-share | DESIGN.md「验证器」表 + verifier.ts；`urtext verify` 自举 13 子句实况 |
| 04 linker/impact | refs 建图、text_hash 变更→stale 反向闭包、evidence invalidated_at | ROADMAP M2 + linker.ts；`urtext impact specs/urtext/spec.md#C007` |
| 05 DWARF | clause_code_map、provenance 信 diff 不信自述、unmapped→exit 1、blame 反查 | DECISIONS D4 + dwarf.ts；`urtext map/ack/blame`、`check --diff` |
| 06 元验证+裁决门 | 异源审计协议 urtext-meta-audit/v0、只读证据不重跑、gate 逐子句 auto-pass 条件 | DECISIONS D3 + audit.ts/gate.ts；`urtext audit --export/--import`、`gate --diff` |
| 07 unsafe 车道 | risk:high 全绿也不自动过、review 绑 HEAD sha、HEAD 变更即失效 | VISION P5 + review.ts；`urtext review --approve/--reject` |

### 上手层 guides/

| 文件 | 讲清什么 | 锚点 |
|---|---|---|
| 01 快速上手 | cd 已有仓库→建 specs/→写 C001→check→verify，10 分钟闭环 | README quick start 扩写 + ROADMAP 种子门槛 |
| 02 子句手艺 | 粒度指南（何时设子句/何时留 prose）、oracle 选型决策、避免 `cmd:true` 作弊 | VISION P1/§6 非目标 + BRIEF 风险 #2/#3 |
| 03 命令参考 | 12 命令逐条：签名/退出码/证据落点（index check verify impact map ack blame audit gate review decide decisions） | src/cli.ts USAGE 全量 |
| 04 持久化立场 | Urtext 对 spec-persistence 三模型的回答：修订链≈flow-forward，stale 传播≈living，但都是执法非约定 | VISION P3 + SYNTAX 注册表 + spec-persistence.html |
| 05 采用与边界 | 渐进采用（P8 git-native 无服务器）、P9 证伪条件（manual>50% 停）、非目标清单、何时该用 Spec Kit 而非 Urtext | VISION §4 P8/P9 + §6 非目标 |

## 五、阶段（每阶段独立可合、独立有值）

严格按「先立门面与差异化 → 补机制 → 补上手」排序；理念层是种子用户的第一触点，优先。

### 阶段 A：门面 + 理念层（最高价值，先讲清"为什么该看"）
- A1 `docs/wiki/index.md`：一句话定位、三层导航、状态徽章（引 README status）。
- A2 concepts/01–03、06：范式迁移、汇编→C、可判定、隐喻——**纯理念，无需核对命令**。
- A3 concepts/04–05：vs SDD + 事实源翻转——**本规划一/二节的对比结论落文**，直引 Spec Kit 三文档。
- 验收：外部读者读 04/05 能复述本质差异；所有 Spec Kit 引用带链接与准确转述。

### 阶段 B：机制层（把 DESIGN/SYNTAX 重组为读者视角）
- B1 mechanisms/01–03：语言层/注册表/验证器——每篇跑通所引命令，贴**本仓库真实输出**。
- B2 mechanisms/04–07：linker/DWARF/元验证/unsafe——同上，子句 id 用 specs/urtext/ 实际存在的。
- 验收：每个命令块在本仓库可复制即跑；引用的 C 子句 id 经 `grep specs/urtext/` 核实存在。

### 阶段 C：上手层（对齐种子验证）
- C1 guides/01 快速上手 + 03 命令参考：从 src/cli.ts USAGE 逐条核对，退出码准确。
- C2 guides/02 子句手艺 + 04 持久化 + 05 采用边界。
- 验收：按 guides/01 在一个空目录能 10 分钟走完 check+verify；命令参考覆盖全部 12 命令。

### 阶段 D：dogfood 收尾（wiki 自身进执法体系）
- D1 README 增「Documentation」区块链到 wiki index，替换/补充现有 docs 链接。
- D2 评估是否为 wiki 一致性加一条 cmd 子句（如「命令参考覆盖 cli.ts 全部命令」的 grep 判定），
     进 specs/urtext/ 由 `urtext verify` 管辖——**让 wiki 不腐烂靠机制而非自觉**（呼应 D3 文本层守卫思路）。
     若成本 > 价值则显式 ack 落 DECISIONS，不留悬空。

## 六、纪律约束（贯穿全程）

1. **诚实边界**：任何未验证运行路径（如 M5b 多模态 oracle）标注「v1，未实现」，不写成已有能力（沿用 BRIEF-loops 第一节纪律）。
2. **单一事实源**：wiki 不复制 VISION/SYNTAX 的规范文本，而是**转述 + 链回**；规范变更只改源，wiki 引用不漂移（CLAUDE.md §18）。
3. **命令即证据**：每个 CLI 示例必须在本仓库实跑过再落文，贴真实退出码/输出片段。
4. **差异化克制**：对 Spec Kit 只做事实层对比（引其原文 + 指出缺 oracle/linker/DWARF），不贬损、不夸大。
5. **逐阶段 commit**：每阶段一个逻辑单元，完成即审 diff 并 commit（CLAUDE.md §7/§15）。

## 七、已知未知（等写作中暴露）

- wiki 站点是否要静态生成器（docfx/mkdocs）还是纯 markdown——**默认纯 markdown**（P8 无服务器、渐进），
  除非种子用户明确要托管站点再评估，不预支。
- guides/02 子句手艺能否文档化「妙到毫巅」的粒度手感——BRIEF 风险 #3 明标未验证；
  先写决策树版本，真实 design partner 反馈后再迭代。
- D2 的 wiki 一致性子句成本——写时评估，可能落 ack 而非硬子句。

## 2026-07-17 文档源重排

- 中文 Wiki Markdown 源从 `docs/wiki/app/content/zh/` 迁至 `docs/zh-CN/wiki/`；中文文档与英文文档各自位于语言根目录。
- `docs/wiki/app/` 只保存构建器、前端资源和生成的离线站点 `index.html`。
- 构建器从 `docs/zh-CN/wiki/` 读取中文镜像，并要求全部 19 篇翻译存在；缺失翻译会使构建失败。
- 根 README 不再重复维护发布状态，分别链接英文与中文 Wiki 的状态段落。