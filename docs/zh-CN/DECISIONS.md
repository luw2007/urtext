# 关键结论存档（Decisions）

> 沉淀自 2026-07 奠基讨论中未进入 VISION/DESIGN 的结论。每节独立成立；
> 推翻任何一节需要新的证据，不允许静默漂移。

## D1 市场定位：为什么现有工具不解决这个问题

| 工具 | 已做 | 缺口 |
|---|---|---|
| Spec Kit / OpenSpec / Kiro | spec 模板、SDD 流程、/specify→/plan→/implement | 句子不可判定（无 oracle）、无 linker、无 DWARF——靠 prompt 纪律防 Spec 腐败，已被实践证明失败 |
| CodeRabbit CLI | 本地未提交 diff 审查、agent 修复循环 | 工作对象是**代码层**；不承载意图，无验收闭环 |
| Claude Agent Teams / Codex App | 多 Agent 并行、worktree、任务共享 | 编排是模型厂商的地盘，已商品化；不回答"生成的对不对" |
| Gastown | 20-30 Agent 编排、merge queue、质量趋势 | quality review 是 measurement-only 不阻断；无行级/子句级人类裁决。**互补不替代**：Gastown 编排 agent，Urtext 验收产出 |

结论：所有人都在做"怎么生成"和"怎么编排"，没人做"意图↔代码↔证据的可判定闭环"。
这是 Urtext 的空位，也是唯一值得押注的差异。

## D2 许可证（法务边界）

- Urtext 全新 MIT，从零开发，无浏览器运行时依赖。

## D3 同源验证陷阱（为什么"AI 自评 + 换模型"不够）

AI 写的测试验证 AI 的实现是**同源验证**：红绿只证明"AI 对 spec 的理解自洽"，
不证明 criterion 被满足。换一个 SOTA 模型对抗只换了模型，没换维度——两个模型
可能一致地误解同一条 spec。这就是"TDD/SDD 红绿实践最终效果不好"的根因。

破解不是再加一个 LLM，而是引入独立于 spec 与实现之外的第三方 ground truth：
oracle 产出的客观证据。跨模型对抗只保留在**元层**——审"证据是否真覆盖子句语义"
（oracle 太弱、测试作弊、diff-scope 规避），并且：

- 实现 preset ≠ 元验证 preset（Claude 实现则 Codex 审，反之亦然）；
- 元验证不重跑实现，只读证据，token 成本约为实现的 1/10；超预算降级为抽样审计；
- 输出逐子句 agree/disagree；disagree 自动升级人工，永不静默吞掉。

这同时满足 AI-first（默认自动）与 human-closed-loop（分歧必到人）两种立场——
分歧的实质从"要不要人"变成"什么触发人"。

## D4 DWARF 层执法机制（P3 的操作细节）

- `clause_code_map(clause_id, spec_path, file_path, line_start, line_end,
  commit_sha, dispatch_id, content_hash)`：子句→代码映射。
- 写入规则：agent report 携带 `clause_outputs`（每条子句→声称覆盖的 diff 范围），
  server 用**当时真实 git diff 交叉验证**范围存在才落库——
  **provenance 不信 LLM 自述，信 diff**。
- unmapped change 检测：合并门禁扫描 diff，无法归因到任何子句/dispatch 的 hunk
  标记为 unmapped，强制 (a) 回写 spec 产生新子句，或 (b) 显式 manual-ack 落
  Decision。手改不禁止，但必须可见、必须回写——事实源翻转唯一可靠的执法点。
- 失败归因：oracle/CI 失败 → 命中代码范围 → 反查子句 → 报"违反 C001"，
  不报栈帧。没有这层，人被迫跌回代码层，抽象作废。

## D5 汇编→C 类比的完整六条件

VISION 收录了四主条件，讨论中还有两个次要但必要的条件：

5. **抽象机保留成本模型**：C 藏寄存器但保留内存/指针成本可见性。
   Urtext 对应：risk 标注、延迟/爆炸半径/可逆性是子句的一等属性，
   抽象不能把"这个改动多危险"藏掉。
6. **逃生舱**：`inline asm`/`volatile` 让 5% 抽象失效的场景有出口。
   Urtext 对应：`risk:high`/unsafe 块——不假装全部行为可 spec 化，
   高危 path 显式跌回代码级人工审查，而不是让整个体系崩塌。

另一个反面结论：**伪代码永远不是答案**——它与代码同属"机制(how)"范畴，
只增加模糊度，且丢掉了代码唯一的优点（可执行）。换范式换的是描述对象
（"必须满足什么"），不是描述精度。

## D6 隐喻体系（品牌与文档叙事的权威版本）

古典乐出版对照：

| Urtext 出版实践 | 本系统 |
|---|---|
| 净本 = 唯一权威，演奏是诠释 | spec 是事实源，代码是投影 |
| 每场演奏可以不同 | LLM 随机性；同 spec 多次生成不同代码 |
| 走调可判定 | oracle |
| 校勘记（critical apparatus）注明每处依据 | evidence + provenance |
| 编辑添改必须标注区分于原稿 | unmapped change 执法 |
| 对照多份手稿考订正文 | 跨模型元验证 |
| 被历代编辑污染的谱子 | Spec 腐败 |

角色链：**指挥 = 人**（看总谱裁决走调，不演奏乐器）；**乐手 = AI agents**；
**演奏 = 代码**；**调音器 = oracle**。产品是指挥台上那份净本，
不是指挥本人——工具以"它是什么"命名，不以"谁在用"命名。

命名教训（五轮否决 tenet/oath/seal/score/conductor 后）：
"契约/编排/乐谱"语义场已被三代工具占满，是编程语言作者的第一直觉词库；
好名字在隐喻的**载体/仪式/凭据**层，不在核心概念词本身。

## D7 Spec Coding 反模式 → 机制映射

社区 SDD 文章反复指出的三大反模式，本系统的机制化回答：

| 反模式 | 靠纪律的解法（已证失败） | Urtext 的机制 |
|---|---|---|
| Gate 粗糙（"要快"不可量化） | 模板与评审规范 | P1：无 oracle 即语法错误，进不了 ready |
| Spec 腐败（实现后不回写） | "彻底实现并删除旧文件"式清理指令 | D4：unmapped change 执法 |
| 迭代中 spec 漂移 | 人工同步历史文档 | linker stale 传播 + `urtext impact` |
