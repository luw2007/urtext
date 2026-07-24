# Spec 影响联动面板（Spec Impact Panel）— 实施计划

- 日期：2026-07-23
- 前置：`docs/plans/urtext-20260723-spec-impact-panel-review.md`（commit `ed66475`，结论 REQUEST CHANGES / Architecture BLOCK）
- 定位：本计划是该审查裁决后的**重写方案**，取代被否决的 React/Tailwind/Playwright 补丁。
- 一句话：在现有 `review-ui.ts → ui-server.ts` 服务端渲染架构内，为 `/brief` 页补齐结构化的风险 / stale / 映射代码摘录 / 影响闭包呈现，为 console 首页补工作区级 unmapped 红色告警；全程复用 `buildBrief()` / `detectUnmapped()` 领域函数，零新命令、零新存储、零第二套 UI 栈。

## 一、审查裁决 → 本计划的落法（逐条对照）

| 审查项 | 裁决 | 本计划落法 |
|---|---|---|
| P0 技术栈不符 | 不引入 React/Tailwind | 只改 `src/review-ui.ts`（纯逻辑+HTML 字符串）与 `src/ui-server.ts`（薄壳），沿用自包含 HTML + 原生 fetch |
| P0 CLI 契约误用 | 禁止拼接 shell 命令 | server 直接调用 `buildBrief(db, root, { specPath, clauseId })`、`impact()`（已在 brief 内）、`detectUnmapped(db, root)`；不启动任何 `urtext` 子进程，不解析 CLI 文本 |
| P0 错误路径显示绿色低风险 | fail-closed | 服务端同步渲染，无客户端 loading 竞态；`buildBrief` refusal（unknown_clause/not_ready/link_error）渲染为明确的 HTML 错误页（保留 404/409 状态码），**不输出任何风险徽章**；`detectUnmapped` 出错时 console 显示红色错误横幅而非静默清空 |
| P0 浏览器执行命令 | 不成立 | 数据全部在 server 侧同步聚合后随 HTML 一次性下发，浏览器只渲染 |
| P0 概念混淆 | 语义改准 | `impact` 文案为"影响闭包（若本条款变化，潜在波及）"；`stale` 单独成节为"当前证据状态"；映射节标题明示"映射代码摘录（当前工作区内容，非 Diff）"；unmapped 只出现在 console 工作区级横幅 |
| P1 四次读取非一致快照 | 一次聚合 | 现有 `/brief` 处理路径本就是同步单次聚合（同一 `buildBrief` 调用、同一 `manifest.head`），无需 AbortController |
| P1 Diff 需求 | 二选一 | **选方案 1**：本期复用 `manifest.mappings[].content` 摘录；真实 mapped Diff 列入独立门控的 Phase 4（默认不做，见"分阶段"） |
| P1 unmapped 作用域 | 工作区级 | console 顶部横幅列出 `<file>:<start>-<end>`；`/brief` 页不重复出现、不做 Spec 归属 |
| P1 空态失败态 | 分别表达 | 见"三、状态语义矩阵" |
| medium 风险 | 不做 | 风险类型保持 `'low' | 'high'`（`BriefManifest.risk` / `UiClause.risk` 原样），UI 不出现第三档 |
| Playwright | 本期不做 | P0 用 Vitest + HTTP 集成测试（Node ≥22 自带 fetch）；Playwright 仅在 Phase 4 且满足全部接入条件时另行立项 |

## 二、数据契约（UI projection，非第二事实源）

新增只读投影类型（`src/review-ui.ts`），字段**全部**取自一次 `buildBrief()` 返回值，不复制任何计算：

```ts
export interface SpecImpactView {
  schema: 'urtext.spec-impact/1'
  head: string | null                    // = manifest.head
  target: { specPath: string; clauseId: string }
  risk: 'low' | 'high'                   // = manifest.risk（无 medium）
  stale: boolean                         // = manifest.stale（最新证据被 invalidate）
  hasEvidence: boolean                   // = manifest.evidence !== null
  mappings: BriefMapping[]               // = manifest.mappings（摘录，非 Diff）
  impact: ImpactReport                   // = brief.impact（潜在影响闭包）
}

export const buildSpecImpactView = (brief: Brief): SpecImpactView => ({ /* 纯字段搬运 */ })
```

决策与偏差说明：

1. 与审查文档建议模型的唯一偏差：**不含 `workspaceUnmapped` 字段**。理由：审查自身认定 unmapped 是工作区级事实、"不要伪造 Spec 归属"；将其放入 per-clause view 会诱导页面级归属误读，且 `/brief` 每次请求重跑 `detectUnmapped` 纯属浪费。unmapped 数据走 `UiSnapshot`（console 首页），两处各自对应自己的作用域。
2. `hasEvidence` 是渲染空态所需的最小补充（`manifest.stale` 在无证据时为 `false`，若不区分会把"尚无证据"渲染成"当前有效"——那是审查点名的错误绿色结论变体）。
3. `renderBriefText()` 的 `<pre>` 全文**保留不动**，仍是 CLI/UI 共享的单一渲染器（C104 纪律）；`SpecImpactView` 只驱动 `<pre>` 上方的结构化摘要条，不替代它。

`UiSnapshot`（console）扩展：

```ts
export interface UiSnapshot {
  // …现有字段不变…
  /** detectUnmapped 成功时的工作区级 unmapped hunks。 */
  unmapped: DiffHunk[]
  /** detectUnmapped 失败原因；非 null 时 UI 必须显示错误横幅（fail-closed）。 */
  unmappedError: string | null
}
```

现状 `buildUiSnapshot` 第 56 行 `'error' in unmappedReport ? [] : …` 会把检测失败静默折叠成"无 unmapped"——正是审查禁止的"错误默认成安全"。改法：错误照旧不注入 `buildStatus`/`adjudicate`（gate 语义本期不动，见"风险"），但必须原样存入 `unmappedError` 交给渲染层。

## 三、状态语义矩阵（页面可观察行为）

| 事实 | `/brief` 页呈现 | 语义属性（供测试断言） |
|---|---|---|
| risk high | 红色徽章 `[high]` | `data-state="risk-high"` |
| risk low | 灰色徽章 `[low]`（仅在 brief 构建成功后出现） | `data-state="risk-low"` |
| stale（有证据且被 invalidate） | "证据已过期 — 需重新 verify" | `data-state="stale"` |
| 有证据且未 stale | "当前有效" | `data-state="fresh"` |
| 无证据 | "尚无证据 — 运行 `urtext verify`"（不显示"当前有效"） | `data-state="no-evidence"` |
| mappings 为空 | "尚无映射代码" | `data-section="mappings"` 空态文案 |
| mappings 非空 | "映射代码摘录（当前工作区内容，非 Diff）" + 复用 `<pre>` 内既有 40 行截断摘录 | `data-section="mappings"` |
| impact 闭包为空 | "无下游影响" | `data-section="impact"` 空态文案 |
| impact 闭包非空 | "影响闭包（潜在波及，非已 stale 列表）：N 个条款 + M 个任务"，逐项 `spec#clause` 链接到各自 `/brief` | `data-section="impact"` |
| buildBrief refusal | HTML 错误页：原样透出 refusal message，无任何风险/stale/映射节 | HTTP 404（unknown_clause）/ 409（not_ready、link_error），`data-state="error"` |

| 事实 | console 首页呈现 | 语义属性 |
|---|---|---|
| unmapped 非空 | 顶部红色横幅："N 个未归属变更（工作区级，git diff HEAD，未跟踪文件不在检测范围）"，逐项 `<file>:<start>-<end>`，附既有提示 `map / ack / spec write-back via CLI` | `data-banner="unmapped"` |
| unmapped 为空且检测成功 | 无横幅（现有队列行为不变） | — |
| detectUnmapped 失败 | 顶部红色错误横幅："unmapped 检测失败：<原因> — 本页不能证明不存在未归属变更" | `data-banner="unmapped-error"` |

文案规则：所有动态内容（文件路径、refusal message、git 错误串、条款标题）一律过现有 `esc()`；断言用 `data-*` 语义属性，不用颜色/样式选择器。

## 四、文件级改动

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/review-ui.ts` | ① `SpecImpactView` 接口 + `buildSpecImpactView(brief)` 纯投影；② `UiSnapshot` 增 `unmapped`/`unmappedError`，`buildUiSnapshot` 填充（`detectUnmapped` 结果不再静默丢弃）；③ `renderPage` 顶部横幅（两种 `data-banner`）；④ `handleBrief` 成功体增 `view` 字段；⑤ `renderBriefPage` 增参 `view: SpecImpactView`，在 `<pre>` 上方渲染结构化摘要条（徽章 + stale 节 + impact 列表 + mappings 空态）；⑥ 新增 `renderBriefErrorPage(message)`：refusal 的 HTML 错误页 | 核心，纯逻辑可单测 |
| `src/ui-server.ts` | `GET /brief` 分支：refusal 时改为 `renderBriefErrorPage`（状态码沿用现有 404/409）；成功时把 `result.body.view` 传给 `renderBriefPage`。路由白名单、CSRF、Origin/Host、body 上限、`/api/*` JSON 行为**一律不动** | 薄壳适配 |
| `src/index.ts` | export `SpecImpactView`（若该文件现有导出 UI 类型的先例；否则不加） | 尾随 |
| `tests/review-ui.test.ts` | 扩展既有 describe（沿用 `setupRepo`/`setupReviewable` fixture）：见"五、测试" | 测试 |
| `tests/ui-server.test.ts` | 新建：HTTP 集成测试（首个 `startUiServer` 真实回路测试） | 测试 |
| `docs/wiki/guides/03-command-reference.md` | 仅当 `urtext ui` 段描述了页面内容时同步一句话；无命令集变更 | 收尾 |
| `docs/logs/implementation-notes-spec-impact-panel.md` | 实施注记（偏差、被迫决策） | 收尾 |

明确不改：`src/brief.ts`、`src/dwarf.ts`、`src/linker.ts`、`src/status.ts`、`src/gate.ts`、`src/cli.ts`、`package.json`（零新依赖）、registry schema（零新表）、`scripts/oracle-wiki.sh`（命令集未变，C015/C006 不触发）。

## 五、测试（全部走现有 Vitest 栈）

### 5.1 Vitest 领域/渲染测试（`tests/review-ui.test.ts` 扩展）

1. `buildSpecImpactView`：high/low 风险原样透传；`stale`/`hasEvidence` 三态（无证据 / 有效 / stale，stale 用 `propagateStale` 或修改被 ref 条款后 `scanWorkspace` 触发）；`impact.affectedClauses` 与 fixture refs 图一致；字段与 `buildBrief` 返回值逐项相等（投影不产生新事实）。
2. `renderBriefPage`：`data-state="risk-high"` 只在 high 出现；无证据时输出 `no-evidence` 而非 `fresh`；空 mappings 输出"尚无映射代码"；空 impact 输出"无下游影响"；title/路径含 `<script>`、`'`、`&` 时输出无裸标签（复用现有转义测试模式）。
3. `renderBriefErrorPage`：refusal message 被转义呈现；输出不含任何 `data-state="risk-*"`。
4. `buildUiSnapshot`：工作树造一个未归属 hunk（改 tracked 文件不 map）→ `unmapped` 含该 `<file>:<start>-<end>`；`recordMapping`/`recordAck` 后消失；git 失效场景（临时目录破坏 `.git` 或非 git 根）→ `unmappedError` 非 null。
5. `renderPage`：`unmapped` 非空 → 含 `data-banner="unmapped"` 与具体 hunk 键；`unmappedError` 非 null → 含 `data-banner="unmapped-error"` 与原因文本；两者互斥；空且成功 → 两横幅皆无。
6. 截断约束回归：>40 行映射内容的条款，`/brief` 输出仍含 `… N more line(s) (hashed in full)`（`renderBriefText` 未被破坏），且 `briefHash` 与全量内容绑定（改第 41 行后 hash 变化）。

### 5.2 HTTP 集成测试（`tests/ui-server.test.ts` 新建）

fixture：`mkdtempSync` 临时 git repo（复制 `setupRepo` 模式）+ `:memory:` registry；`await startUiServer(db, root, { port: 0, open: false, decider: 'test' })`；用全局 `fetch` 打真实回路；`afterEach` 调 `handle.close()` + 清理临时目录。不引入任何测试专属 query 开关。

1. `GET /` → 200，HTML 含 console 标题；造未归属 hunk 后再请求 → 含 `data-banner="unmapped"` 与 hunk 键。
2. `GET /brief?spec=…&clause=C001` → 200 `text/html`，含 `data-state="risk-*"` 与 `<pre>` brief 文本。
3. `GET /brief?spec=specs/x/spec.md&clause=C999` → 404，HTML 错误页含 `unknown_clause` 语义文案，不含风险徽章。
4. spec 处于校验失败修订（写入非法 clause 行）→ 409 错误页（`not_ready`）。
5. `GET /api/brief` 仍返回 JSON（含新 `view` 字段，schema 为 `urtext.spec-impact/1`）。
6. 安全边界回归：`POST /api/decide` 无 `x-csrf` → 403；伪造 `Origin: http://evil.example` → 403（证明本改动未松动边界）。

### 5.3 Playwright E2E

本期**不交付**。仅当 Phase 4 立项且一次性满足：正式 devDependency + `playwright.config`（webServer 指向 `urtext ui --no-open`）+ 确定性 fixture git repo + CI browser install 步骤 + 语义选择器纪律——五者缺一即不引入。裸测试文件禁止合入。

## 六、分阶段交付

### Phase 1：投影 + `/brief` 结构化呈现（纯逻辑）

改动：`review-ui.ts` 的 ①④⑤⑥ + `ui-server.ts` 的 `/brief` 分支 + 测试 5.1.1–5.1.3、5.1.6。

验证命令与预期：

```
npm run check                      # 预期：tsc 零错误
npx vitest run tests/review-ui.test.ts
                                   # 预期：既有用例全绿 + 新增投影/渲染/错误页用例绿
```

### Phase 2：console unmapped 横幅（fail-closed）

改动：`review-ui.ts` 的 ②③ + 测试 5.1.4–5.1.5。

```
npx vitest run tests/review-ui.test.ts
                                   # 预期：横幅三态（有 hunk / 无 / 检测失败）用例绿
```

### Phase 3：HTTP 集成 + 冒烟 + 收尾

改动：`tests/ui-server.test.ts` + wiki 一句话（如需）+ implementation-notes。

```
npx vitest run tests/ui-server.test.ts   # 预期：5.2 全绿，含 403 安全回归
npm test                                 # 预期：全套既有测试无回归
npm run build && node dist/cli.js ui --no-open --port 4399 &
curl -s http://127.0.0.1:4399/ | grep -c 'data-banner\|urtext console'
curl -s 'http://127.0.0.1:4399/brief?spec=specs/urtext/spec.md&clause=C001' | grep -c 'data-state'
                                         # 预期：真实仓库页面含语义属性；随后 Ctrl-C/kill 净退
sh scripts/full-test.sh                  # 预期：ALL GATES PASS
```

每个 Phase 是独立可合并的逻辑单元：验证绿即 commit（不 push）。

### Phase 4（门控，默认不做）：真实 mapped Diff

启动条件：操作数据表明摘录不足以支撑高危审查判断（而非"看起来更好"）。届时才做：UI 只读聚合层新增结构化 mapped-diff——`git diff --unified=3 HEAD -- <file>`（argv 数组、`shell:false`，同 `dwarf.ts` 的 `git()` 模式）解析 hunk 内容行，仅保留与该条款 `mappings` 行区间相交的 hunk；命名与摘录严格区分。同批评估 rename/纯删除/二进制文件策略与 Playwright 立项。本计划不为其预留代码。

## 七、验收标准（对照审查"验收门槛"）

- [ ] 无 React/Tailwind/新依赖/新命令/新表；`package.json` 与 registry schema 零 diff。
- [ ] 数据路径：`{specPath, clauseId}` → `buildBrief`/`detectUnmapped`，全程无 shell 字符串拼接、无 CLI 文本解析。
- [ ] 风险仅 `low|high`；任何 refusal/检测失败路径不出现 `risk-low` 徽章或绿色结论。
- [ ] "映射代码摘录"与"Diff"文案不混用；impact 与 stale 分节呈现。
- [ ] unmapped 仅工作区级横幅，逐项列 hunk；检测失败显式报错。
- [ ] 空态、错误态、特殊字符转义、CSRF/Origin 边界均有行为测试且绿。
- [ ] `npm run check`、`npm test`、`scripts/full-test.sh` 全绿；冒烟 curl 输出符合预期。

## 八、回滚策略

纯 UI 呈现层改动：无 schema 迁移、无数据写路径变更、无命令面变更。回滚 = revert 对应 commit（每 Phase 一个逻辑单元），registry 与 ledger 不受影响。`handleBrief` JSON 体是加字段（`view`），对既有消费方（页面内 fetch `/api/brief` 只读 `briefHash`/`error`）向后兼容。

## 九、风险与已知边界

- **gate 语义未动**：`buildUiSnapshot` 在 `detectUnmapped` 失败时仍以 `unmapped=0` 调 `adjudicate`（现状行为）。本期只把失败**显性化**到横幅；把失败传导进 gate 判定属于领域层变更，超出 UI-only 范围，记入 implementation-notes 供后续单独裁决。
- **`git diff HEAD` 盲区**：未跟踪文件不产生 hunk，横幅文案明示该边界，不宣称"无横幅 = 全部已归属"。
- **行漂移**：映射按记录时行区间锚定读取当前工作树内容（`rangeContent`），后续编辑可致摘录与原语义漂移；`<pre>` 已显示 `@ <commitSha>`，摘要条不重复宣称新鲜度。
- **签名变更半径**：`renderBriefPage` 增参会改 `ui-server.ts` 调用点与既有测试调用点——属同一逻辑单元内的封闭变更，`lsp references` 确认无其他调用方后再动。

## 十、三级认知矩阵

**已知的已知**
- 风险模型只有 `low/high`（`brief.ts:57`）；unmapped 是工作区级（`dwarf.ts:268-297`）；`git diff HEAD` 不含未跟踪文件（`dwarf.ts:97`）；映射行区间不自动重锚；摘录展示截断 40 行但全量参与 `briefHash`（`brief.ts:256,288-293`）；`/brief` 现有路径已是单次同步聚合、同一 HEAD。

**已知的未知**
- 大型映射摘录（数百行 × 多映射）的页面体量与浏览器渲染上限——P0 靠既有 40 行截断兜底，未实测极端值。
- `detectUnmapped` 各类失败形态的真实错误串（非 git 目录、损坏 index、rebase 中途）——测试覆盖典型两类，长尾靠横幅原样透出。
- 未来若做真实 Diff：rename/纯删除/二进制/跨映射区间 hunk 的展示策略（Phase 4 前不决策）。

**未知的未知**
- 极端路径编码或控制字符对 HTML 渲染的影响——统一 `esc()` 是当前唯一防线，测试仅覆盖常见特殊字符。
- 页面打开期间用户切换分支/HEAD：服务端每次请求重新 `scanWorkspace` + 聚合，刷新即一致，但"打开着的旧页面"与新 HEAD 的错位无提示。
- 存量映射漂移导致"可导航但内容不再对应原意"的误导——摘录如实呈现当前内容，语义核对仍属人的判断。


## 十一、交互补全修订（2026-07-23，用户验收反馈）

运行态验收确认原计划只交付了 projection，不足以完成“打开 UI 即判断 Spec 影响”的用户任务。以下修订覆盖并取代“Phase 4 默认不做”的决定；本轮必须完整交付。

### 11.1 信息架构

1. **Console / Specs**：首页除双车道队列外，必须提供全部 live clause 浏览表。按 `specPath` 分组，行内展示 clause id、title、risk、evidence/stale 状态与“查看影响”链接。无待办的 auto-pass 条款也必须可进入，不能只从队列访问。
2. **Clause detail (`/brief`)**：固定顺序呈现导航、条款身份与风险、证据状态、映射状态、Blame Diff、stale dependencies / potential impact、原始 brief、可用审查动作。
3. **Workspace changes**：unmapped 横幅中的每个 hunk 必须可定位、可复制；显示精确 CLI 命令模板和“刷新状态”入口。不得伪造 Spec 归属。

### 11.2 Blame Diff 合同

- `BriefMapping` 增加 `diff: string | null`、`diffError: string | null`。
- diff 基线是 mapping 的 `commitSha`，终点是当前工作树：`git diff --unified=3 <commitSha> -- <filePath>`，使用 argv 数组、无 shell。
- 只保留与 mapping `[lineStart,lineEnd]` 相交的 hunk；同文件远处 hunk 不得泄入当前条款。
- 多 mapping 按文件/行号稳定排序；UI 按文件分组显示 `<pre data-section="blame-diff">`。
- 无变化显示“映射范围自记录基线以来无代码变化”；git/解析失败显示明确错误，不降级成空 Diff。
- 删除、rename、二进制 diff 无法可靠做新侧区间相交时必须标注 unsupported/error，不伪造成功。

### 11.3 stale dependencies 合同

- `stale` 继续表示当前条款自己的证据是否失效。
- `impact.affectedClauses` 表示潜在下游，不得标成已 stale。
- UI 必须将 dependent clauses 逐项列出并带链接，同时标注每个 dependent 当前 evidence stale 状态。为此 projection 可增加结构化 dependent 状态，但事实必须来自 registry 最新 evidence，不从文本推断。
- 空态分别为“当前条款证据有效/无证据”“无下游依赖”，不能统一显示 None。

### 11.4 交互状态

- 服务端同步页没有网络 loading skeleton，但必须提供显式 `刷新状态` 链接；刷新重新 scan 并用当前 HEAD 构建一致快照。
- detail 页提供返回 console、上一个/下一个 clause（同 spec）、查看全部 Specs。
- 所有动作使用稳定 `data-*` / link 文本；键盘可访问，动态状态用 `aria-live`。
- 风险仍只有 `low|high`；不伪造 medium。

### 11.5 新增验收

- 首页可从 Specs 表进入任意 live clause，包括 auto-pass / 非队列条款。
- 有 mapping 且代码变化时 `/brief` 显示真实 `-old/+new` patch；远处非映射 hunk 不显示。
- 无 mapping、无变化、diff error 三态可区分。
- dependent clauses 逐项显示并可导航，stale 状态来源可验证。
- unmapped hunk 展示精确范围和可复制命令模板；刷新后已 map hunk 消失。
- HTTP 集成覆盖全部导航和状态；真实浏览器完成：首页 → 任意 Spec → Blame Diff → dependent clause → 返回/刷新。