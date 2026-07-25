# Implementation notes — Spec impact panel

Plan: `docs/plans/urtext-20260723-spec-impact-panel.md`. Review: `docs/plans/urtext-20260723-spec-impact-panel-review.md`.

## 决策与偏差

1. **结构化摘要不替代 brief 文本**：`SpecImpactView` 只是 `buildBrief()` 结果的只读 projection；`renderBriefText()` 仍是 CLI/UI 共享事实渲染器。摘要用于区分风险、证据状态、映射摘录与影响闭包，不产生第二套计算。

2. **映射摘录与 Blame Diff 并存**：mapping 当前内容继续进入共享 brief 与 brief-hash；UI 额外展示从 mapping `commit_sha` 到当前工作树的真实 before/after patch。无 mapping、无变化与 diff error 分别呈现。

3. **unmapped 保持工作区级**：未归属 hunk 在完成 map/ack/spec write-back 前没有可证明的 Spec owner，因此只在 console 展示，不进入 per-clause `SpecImpactView`。

4. **检测失败与空结果分离**：`UiSnapshot` 增加 `unmappedError`。错误横幅明确说明页面不能证明不存在未归属变更，避免原实现把 `detectUnmapped()` 失败折叠成空数组后的视觉 all-clear。

5. **gate 语义不在本 UI slice 中修改**：检测失败时 `buildStatus()` / `adjudicate()` 仍接收空 hunk 列表；这是存量领域边界。UI 已 fail-closed，但非 UI 消费方仍可能把 status 视为 clean。后续若修改，必须在 status/gate 领域层定义错误传播契约并同步 CLI JSON schema，不能在渲染层暗改。

6. **测试拆分控制 worker 时限**：原 `tests/review-ui.test.ts` 已接近 Vitest 60 秒 worker RPC 阈值。新增 unmapped 与 HTTP 回路分别放入独立文件，避免行为断言全部通过但 runner 因超时 exit 1。未引入 Playwright；真实 Node HTTP + Vitest 已覆盖当前服务端渲染契约。


7. **运行态验收推翻了“摘录足够”假设**：用户要求的“Blame Diff”是 before/after patch，不是当前内容摘录。实现改为以 mapping `commit_sha` 为基线、当前工作树为终点，用无 shell 的 git argv 生成 patch，并按 mapping 新侧范围过滤 hunk。原 Phase 4 门控决定被用户验收反馈覆盖。

8. **UI 必须可浏览全部条款**：仅把 brief 链接放在待办队列，会让 auto-pass 或暂时无 blocker 的条款在 UI 中不可达。console 增加 All Specs 表，详情增加同 Spec 上一条/下一条、返回与刷新导航。

9. **dependency 的 stale 是逐条事实**：impact 闭包只是潜在依赖。详情通过同一次 registry adjudication 为每个 dependent 附当前 evidence/stale 状态；不把 impact 数量伪装成 stale 列表。

## 已知边界

- 风险模型保持 `low | high`；没有 UI-only 的 `medium`。
- `git diff HEAD` 不含未跟踪文件，console 横幅明确显示这一检测边界。
- mapping 按记录时行区间导航，后续行漂移不会自动重锚。
- 摘录展示沿用 40 行上限，完整映射内容仍参与 brief hash。
- 同一个 unmapped hunk 会同时出现在顶部风险横幅和 human queue：前者表达工作区阻塞风险，后者提供逐项动作入口；这是有意的 UX 分层。
