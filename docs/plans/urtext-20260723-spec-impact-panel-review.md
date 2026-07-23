# Spec 影响联动面板方案审查

- 日期：2026-07-23
- 审查范围：用户提供的 `SpecImpactPanel.tsx`、`SpecDetail.tsx`、Playwright 用例及 PR 说明
- 结论：**REQUEST CHANGES / Architecture BLOCK**

## 结论

需求方向合理：风险、映射代码、影响闭包、stale 和 unmapped 应进入现有 `urtext ui`，减少人工拼接 CLI 输出。

当前补丁不可合入。它基于一个不存在的 React/Tailwind/Playwright 前端架构，并误用了现有命令契约。正确落法不是新增 `src/ui/**`，而是扩展现有 `src/review-ui.ts` 的只读视图模型和 `src/ui-server.ts` 的页面渲染；数据直接复用领域函数，不从浏览器拼接并执行 CLI 字符串。

## 已核实的仓库事实

1. UI 是 `src/review-ui.ts` 生成的自包含 HTML，由 `src/ui-server.ts` 的 loopback HTTP server 提供；仓库没有 React、Tailwind、Playwright、`src/ui/pages/SpecDetail.tsx` 或 `runCLI`。
2. `package.json` 仅使用 TypeScript、Vitest 和 `better-sqlite3`。直接加入所示 `.tsx` 无法被当前 `tsconfig.json` 编译。
3. `urtext blame` 接受 `<file>:<line>`，用于代码行反查条款，不接受 Spec ID，也不返回代码 Diff。
4. `urtext impact` 接受 `<spec-path>#<clause-id>`，返回潜在影响闭包；它不是“当前已 stale 依赖列表”。
5. CLI 不存在 `urtext get-risk`；当前风险模型只有 `low | high`，没有 `medium`。
6. `urtext check --diff` / `detectUnmapped()` 返回工作区级 unmapped hunks。unmapped 的定义就是“尚无 Spec 归属”，不能诚实地绑定到某个 Spec。
7. `buildBrief()` 已聚合条款风险、stale、映射代码、证据和 impact；`renderBriefText()` 已在 CLI/UI 间复用，是当前单一事实源。
8. `diffHunks()` 只读取 `git diff HEAD` 的 tracked hunks；未跟踪文件不在检测范围内。

## 阻塞问题

### P0：补丁与真实技术栈不兼容

**证据**：拟新增 React `.tsx`、Tailwind class 和 Playwright 测试；真实仓库为 Node 自包含 HTML + Vitest。

**影响**：文件路径、依赖、构建配置和测试命令均不存在，补丁无法编译或运行。

**改进**：沿用 `review-ui.ts → ui-server.ts` 架构，不引入第二套 UI 栈。只有在产品明确决定整体迁移前端架构时，才单独立项 React 化；本需求不承担该迁移。

### P0：CLI 契约使用错误

**证据**：`urtext blame ${specId}`、`urtext impact ${specId}`、`urtext get-risk ${specId}`。

**影响**：blame/impact 参数不符合真实签名，get-risk 不存在；风险、Diff、依赖三块无法按说明工作。

**改进**：页面目标统一使用结构化 `ClauseTarget { specPath, clauseId }`。读取 `buildBrief()` 返回的结构化事实，禁止解析 CLI 展示文本。

### P0：错误路径会把未知风险显示成绿色低风险

**证据**：风险初始值是 `low`，四个 Promise 均无错误处理，风险输出还通过 `as any` 绕过类型检查。

**影响**：CLI 缺失、输出变化或请求失败时，页面给出最危险的错误结论：绿色 `Risk: low`。

**改进**：状态必须是 `loading | ready | error`；风险不得用“低”作加载/错误默认值。无法读取事实时显示明确错误并阻止风险结论。

### P0：浏览器执行命令的边界不成立

**证据**：React effect 直接调用 `runCLI`，但浏览器不能启动本机进程；真实仓库也没有该桥接层。

**影响**：所谓“纯前端、零后端改动”不成立。若隐藏桥接层经 shell 执行插值字符串，还会形成命令注入风险。

**改进**：server 直接调用已存在的 TypeScript 领域函数。若必须启动外部进程，只能使用 argv 数组和 `shell:false`，但本仓库无需为这些能力启动自身 CLI 子进程。

### P0：产品概念混淆

- `blame` 是“代码行 → 条款”的反向查询，不是“条款 → 代码 Diff”。
- `impact` 是“若条款变化会影响谁”的闭包，不等于“已经 stale 的依赖”。
- unmapped 是工作区全局风险，不属于任何 Spec。
- 当前风险只有高/低；增加“中”属于领域模型和语法变更，违背“只改 UI”。

必须先把 UI 文案和数据语义改准，否则面板会把不同事实合并成一个看似完整但错误的风险结论。

## 高优问题

### P1：四次独立读取不是一致快照

四个异步命令可能跨越不同 HEAD、工作区 Diff 或 registry 状态，组合出从未真实存在过的页面状态；快速切换 Spec 时旧响应还可能覆盖新 Spec。

**改进**：一次 server-side 聚合，返回同一 `head` 下的结构化结果。现有同步领域函数天然避免前端竞态；若以后改为异步 API，客户端需用 `AbortController` 或请求代次丢弃旧响应。

### P1：Diff 需求尚未被现有能力满足

`buildBrief()` 提供映射范围的当前代码内容，不提供 before/after Diff。原方案把 `blame` 输出当 Diff，验收对象错误。

**改进**：二选一并在产品文案中明确：

1. 本期显示“映射代码摘录”，直接复用 `buildBrief().manifest.mappings`；这是零内核改动的最小方案。
2. 若必须显示真实 Diff，在 UI 只读聚合层增加结构化 mapped-diff 计算：读取 `git diff --unified=… HEAD -- <path>`，仅展示与当前条款映射范围相交的 hunk。不得解析 `blame` 文本冒充 Diff。

推荐先落方案 1；真实 Diff 另列验收，避免需求名称与交付事实不一致。

### P1：unmapped 告警作用域错误

原补丁在每个 Spec 面板执行全局 `check --diff`，会让所有 Spec 同时显示同一个告警。

**改进**：在 console 顶部保留工作区级红色告警，列出具体 `<file>:<start>-<end>`；不要伪造 Spec 归属。完成 `map` 后，该 hunk 才能进入对应条款的映射代码上下文。

### P1：缺少明确的空态和失败态

“None”把“确实为空”“命令失败”“数据未就绪”混为一谈。

**改进**：分别表达：

- 无映射：`尚无映射代码`
- 无影响项：`无下游影响`
- 当前条款证据未 stale：`当前有效`
- 数据读取失败：明确错误，不显示绿色结果
- revision building / link error：复用 `buildBrief()` 的 fail-closed 拒绝原因

## 测试审查

所示 Playwright 用例不足以证明功能：

1. `.bg-red-500`、`.text-red-600`、`.text-gray-600` 是实现细节选择器，重构样式即误报。
2. stale 测试只断言恒定标题 `Stale Dependencies`，即使依赖数据完全没加载也会通过。
3. `?unmapped=1`、`C001/C002/C003` 和 `+ // linked code change` 没有可见 fixture 来源。
4. 没有等待/断言 loading、error、空态、快速切换和过期响应。
5. 没有配置 Playwright、webServer、CI 安装浏览器或隔离临时 git workspace。

### 推荐测试分层

1. **Vitest 领域/渲染测试（必须）**
   - `buildBrief()` / 新的只读 view model 返回高/低风险、映射内容、impact、stale。
   - unmapped 是工作区级条目，不重复挂到每个 clause。
   - git/registry 失败时 fail-closed，不产生低风险标签。
   - HTML 对标题、路径、Diff 特殊字符做转义。
   - 大映射内容遵守现有 40 行截断约束，完整内容仍参与 brief hash。
2. **HTTP 集成测试（必须）**
   - 临时 git repo + `:memory:` registry 启动 `startUiServer()`。
   - 请求 `/`、`/brief?...`，验证真实 HTML 与状态码；不使用测试专属 query 开关。
3. **Playwright E2E（若坚持“浏览器全流程”则必须完整接入）**
   - 增加正式依赖、配置、CI browser install 和确定性 fixture repo。
   - 使用 role、可见文本或稳定语义属性，例如 `data-state="risk-high"`，不使用颜色 class。
   - 断言具体依赖 key、具体 hunk 路径/行号、错误态与空态。
   - 至少覆盖：high、low、无映射、真实 stale、全局 unmapped、无影响、特殊字符、服务错误。

## 推荐的最小架构

```text
GET / 或 /brief?spec=<path>&clause=<id>
  → scanWorkspace(db, root)
  → buildBrief(db, root, { specPath, clauseId })
  → detectUnmapped(db, root)                 # workspace-level
  → buildSpecImpactView(...)                 # 只读、结构化、同一 HEAD
  → renderBriefPage(...)                     # HTML 转义后渲染
```

建议结构化模型：

```ts
interface SpecImpactView {
  schema: 'urtext.spec-impact/1'
  head: string | null
  target: { specPath: string; clauseId: string }
  risk: 'low' | 'high'
  stale: boolean
  mappings: BriefMapping[]
  impact: ImpactReport
  workspaceUnmapped: DiffHunk[]
}
```

这不是新的事实源：字段全部来自 `buildBrief()`、`detectUnmapped()` 和当前 HEAD。它只是 UI projection。不要新增数据库表，不要复制风险计算，不要解析 CLI 文本，不要启动四个 `urtext` 子进程。

## 修订后的范围与优先级

### P0

- 在现有 `/brief` 页面强化风险标签、stale 状态、映射代码和 impact 列表。
- 在 console 顶部突出显示工作区级 unmapped hunks。
- 明确 loading/error/empty 语义；任何读取错误 fail-closed。
- 补齐 Vitest 渲染/领域测试和 HTTP 集成测试。

### P1

- 真实 mapped Diff，而不是当前代码摘录。
- 大 Diff 折叠/展开和文件分组。
- 若有明确浏览器回归收益，再正式引入 Playwright；不能只提交一个无配置的测试文件。

### 不在本次范围

- `medium` 风险等级：需要修改 clause 风险模型、解析器、gate 和文档，不是 UI-only。
- 将 unmapped 强行归属到 Spec：没有真实映射前不可推断。
- React/Tailwind 迁移：与本需求无关，且会建立第二套 UI 架构。

## 修订后的风险矩阵

### 已知的已知

- 风险模型只有 `low/high`。
- unmapped 是工作区级事实。
- `git diff HEAD` 不包含未跟踪文件。
- 映射按文件行区间锚定；后续行漂移不会自动重锚。
- `buildBrief()` 已对映射展示截断到 40 行，但完整内容参与 hash。

### 已知的未知

- 大型映射或真实 Diff 的浏览器性能上限。
- rename、纯删除、二进制文件和跨多个映射范围 hunk 的展示策略。
- 是否值得为当前原生 HTML UI 引入 Playwright 的长期维护成本。

### 未知的未知

- 极端路径编码、控制字符或异常 git 输出对未来 Diff renderer 的影响。
- 用户在页面打开期间切换分支/HEAD 时的一致性体验。
- 存量映射行漂移造成“可导航但内容不再对应原意”的误导风险。

## 验收门槛

满足以下条件后才可改为 APPROVE：

- 基于真实仓库架构实现，无第二套 React UI。
- 使用 `{specPath, clauseId}` 结构化目标和领域函数，不拼接 shell 命令。
- 风险只显示真实 `low/high`；失败时不默认低风险。
- 映射代码摘录与真实 Diff 的名称、数据来源不混淆。
- impact 与 stale 分开呈现。
- unmapped 只在工作区级呈现并列出具体 hunk。
- 空态、错误态和特殊字符均有行为测试。
- 若交付 Playwright，fixture、配置、浏览器安装和 CI 命令一并落地。
