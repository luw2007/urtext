# Implementation notes — Spec impact panel

Plan: `docs/plans/urtext-20260723-spec-impact-panel.md`. Review: `docs/plans/urtext-20260723-spec-impact-panel-review.md`.

## 决策与偏差

1. **结构化摘要不替代 brief 文本**：`SpecImpactView` 只是 `buildBrief()` 结果的只读 projection；`renderBriefText()` 仍是 CLI/UI 共享事实渲染器。摘要用于区分风险、证据状态、映射摘录与影响闭包，不产生第二套计算。

2. **本期显示映射代码摘录，不实现 Git Diff**：现有 mapping 提供当前工作区范围内容，不能诚实表达 before/after。页面明确标注“非 Diff”。真实 mapped Diff 只有在操作数据证明摘录不足后才进入独立变更。

3. **unmapped 保持工作区级**：未归属 hunk 在完成 map/ack/spec write-back 前没有可证明的 Spec owner，因此只在 console 展示，不进入 per-clause `SpecImpactView`。

4. **检测失败与空结果分离**：`UiSnapshot` 增加 `unmappedError`。错误横幅明确说明页面不能证明不存在未归属变更，避免原实现把 `detectUnmapped()` 失败折叠成空数组后的视觉 all-clear。

5. **gate 语义不在本 UI slice 中修改**：检测失败时 `buildStatus()` / `adjudicate()` 仍接收空 hunk 列表；这是存量领域边界。UI 已 fail-closed，但非 UI 消费方仍可能把 status 视为 clean。后续若修改，必须在 status/gate 领域层定义错误传播契约并同步 CLI JSON schema，不能在渲染层暗改。

6. **测试拆分控制 worker 时限**：原 `tests/review-ui.test.ts` 已接近 Vitest 60 秒 worker RPC 阈值。新增 unmapped 与 HTTP 回路分别放入独立文件，避免行为断言全部通过但 runner 因超时 exit 1。未引入 Playwright；真实 Node HTTP + Vitest 已覆盖当前服务端渲染契约。

## 已知边界

- 风险模型保持 `low | high`；没有 UI-only 的 `medium`。
- `git diff HEAD` 不含未跟踪文件，console 横幅明确显示这一检测边界。
- mapping 按记录时行区间导航，后续行漂移不会自动重锚。
- 摘录展示沿用 40 行上限，完整映射内容仍参与 brief hash。
- 同一个 unmapped hunk 会同时出现在顶部风险横幅和 human queue：前者表达工作区阻塞风险，后者提供逐项动作入口；这是有意的 UX 分层。
