# 自治 Loop 机制（hunt / fix / audit / integrate）

> 本 feature 将 `.claude/workflows/` 三套 loop 与 `.claude/skills/integrate-worker/`
> 集成协议的承重规则固化为带 oracle 的子句，由 `urtext verify` 统一管辖。
> 来源：docs/VISION.md + Rue 复刻指南（bytedance.larkoffice.com/docx/J66Edv9WxoLK9IxzSh5c6Gipn94）。
> cmd oracle 统一走 `scripts/oracle-loops.sh <check>`——机制活在 prompt/协议文本里，
> 文本丢失即机制失效，文本存在性检查恰好判定这一点。
> 人工验收检查点见 docs/checklists/（引用本文件子句 id）。

## 总则

### C101 裁判永远是运行结果 <!-- oracle:manual risk:high -->

每个 AI 产出的裁判是"运行结果 vs 规范条文"，永远不是另一个 LLM 的意见。
任何 loop 引入"LLM 打分即通过"的路径都是对本条的违反。
（人工复核：docs/checklists/sprint-audit.md）

### C102 信任边界在集成点 <!-- oracle:cmd:scripts/oracle-loops.sh%20trust-boundary risk:high -->

并行 worker 的一切声明视为未验证；loop 产出不直接进主干，
必须经 integrate-worker 协议在新 trunk 上重验。

### C103 事故回写脚手架 <!-- oracle:manual -->

每次 loop 事故必须变成 PREAMBLE / 协议中的一条新规则，附事故编号（issue 号）。
只修当次问题、不落规则，视为事故未关闭。（人工复核：sprint-audit）

### C104 单一事实源 <!-- oracle:cmd:scripts/oracle-loops.sh%20single-source -->

所有 loop 的 agent prompt 必须要求先读 docs/VISION.md——
不允许在 prompt 内复述一份可能漂移的愿景摘要替代之。

### C105 Shell 安全前导 <!-- oracle:cmd:scripts/oracle-loops.sh%20shell-safety risk:high -->

无人值守 loop 的每个"等人类"节点都是全局停机点。hunt 与 fix 两个 loop 的 agent
前导必须包含 SHELL SAFETY 规则：不用 shell 变量拼 rm/mv/重定向目标、
用字面量 /tmp 路径或空值守卫、宁可不删临时文件、永不在仓库 checkout 内 rm。

## hunt loop（urtext-overnight-hunt.js）

### C201 no repro, no report <!-- oracle:cmd:scripts/oracle-loops.sh%20no-repro-no-report risk:high -->

每个 finding 必须附带真实写过、真实运行过的最小复现，及精确观察到的行为
（stdout / exit code / stack）。never confirm something you couldn't run。

### C202 AREAS 地图人写人审 <!-- oracle:manual -->

攻击面地图由人类手写和维护：领域列表、深度提示、已知 bug 排除项。
AI 不得增删改 AREAS 块。地图过期由 sprint-audit 复核。

### C203 领域轮换 <!-- oracle:cmd:scripts/oracle-loops.sh%20rotation -->

coverage ledger 记录每个领域最近扫描日期，每次 run 选取最久未扫领域。

### C204 便宜找、贵验证 <!-- oracle:cmd:scripts/oracle-loops.sh%20model-split -->

find 阶段用便宜模型广撒网（4 finder 并行、角度互斥），
verify 阶段用强模型在当前 trunk 上独立重跑复现后才可归档。

### C205 finding 分类封闭 <!-- oracle:cmd:scripts/oracle-loops.sh%20categories -->

false-verdict / missed-unmapped / crash / reject-valid / accept-invalid 五类封闭枚举；
风格、性能、诊断措辞明确排除在外。

### C206 复现必须 timeout 包裹 <!-- oracle:cmd:scripts/oracle-loops.sh%20timeout -->

被测输入可能使工具死循环，所有复现运行必须 timeout 包裹。

### C207 归档前去重 <!-- oracle:cmd:scripts/oracle-loops.sh%20dedupe -->

归档前先对现有 issue 去重（Rue 弯路 #2：文件型 tracker 被 AI 产出速度冲垮；
Urtext 用 GitHub Issues，禁止建立平行 markdown backlog）。

## fix loop（urtext-fix-cycle.js）

### C301 reproduce first <!-- oracle:cmd:scripts/oracle-loops.sh%20reproduce-first risk:high -->

worker 改任何代码前必须先在自己 checkout 复现每个 bug；复现不了报 refuted——
证伪与修复同等有价值，诚实高于完成度。被证伪的 bug 得到回归 PIN 测试，不是修复。

### C302 覆盖随能力生长 <!-- oracle:cmd:scripts/oracle-loops.sh%20coverage-follows-capability risk:high -->

新增 oracle 类型 / 子句语法 / linker 边 / 检测路径，必须在同一个 change 中
同步增加多用例覆盖（事故来源：Rue RUE-311）。

### C303 产出物隔离 <!-- oracle:cmd:scripts/oracle-loops.sh%20isolation -->

每个 worker 在隔离 git worktree 工作，最多 4 个并行；
产出是 diff 文件 + meta JSON，永不直接 merge。

### C304 预留区间 <!-- oracle:cmd:scripts/oracle-loops.sh%20reserved-ranges -->

并行 worker 对任何全局命名空间（错误码、子句 id 前缀、fixture 编号）的扩展
必须使用各自预留区间。

### C305 禁止 scope creep <!-- oracle:cmd:scripts/oracle-loops.sh%20no-scope-creep -->

worker 只修 cluster 列出的 issue；改动使注释过期必须同一 change 更新注释；
无关改进进 meta.followups，不进 diff。

### C306 provenance dogfood <!-- oracle:cmd:scripts/oracle-loops.sh%20provenance-dogfood -->

所触模块存在带子句 spec 时，worker 须在 meta 中报告 hunk→clause 归因；
无法归因的 hunk 列入 meta.unmapped 并附一行理由，由集成者裁决（VISION P3）。

## audit loop（urtext-spec-audit.js）

### C401 四透镜并行 <!-- oracle:cmd:scripts/oracle-loops.sh%20four-lenses -->

每 sprint 以 drift / soundness / consistency / formal 四透镜并行审计裁判系统本身
（子句、oracle 绑定、证据），防止 oracle 腐烂。

### C402 审计只读 <!-- oracle:cmd:scripts/oracle-loops.sh%20read-only -->

审计 agent 只返回结构化 findings：不改任何东西、不建 issue。
综合、去重、归档由调用方完成。

### C403 行为声称必须 RUN <!-- oracle:cmd:scripts/oracle-loops.sh%20run-required -->

finding schema 强制 `ran` 字段记录实际执行的命令与观察结果；
无 RUN 的行为声称不可采信。findings 必须引用精确子句 id。

## 集成协议（integrate-worker）

### C501 七步协议不可跳步 <!-- oracle:cmd:scripts/oracle-loops.sh%20seven-steps risk:high -->

新 trunk 起步 → 3-way 应用 → 亲手重验每个 repro → 跨机制组合测试 →
全套测试+格式化 → 提交（Fixes #NN 每行一个）→ 处理弹回。
接缝测试是集成者的职责，不能指望 worker（Rue 一晚两次 double-drop）。

### C502 车道纪律 <!-- oracle:cmd:scripts/oracle-loops.sh%20lane-discipline -->

并行 worker 只跨不相交模块集合；热点文件清单人工点名维护，热点必须串行。

### C503 unmapped 门禁 <!-- oracle:cmd:scripts/oracle-loops.sh%20unmapped-gate risk:high -->

集成第 6 步对 meta.unmapped 逐条裁决：回写 spec 产生新子句，或显式 manual-ack
落决策记录。unmapped 非空且未裁决的 diff 不得合入。

### C504 模型路由是人类决策 <!-- oracle:manual -->

集成判断用最强模型且保留给主 loop；fix worker 默认强模型；find 用便宜模型。
调整须落决策记录。（人工复核：sprint-audit）
