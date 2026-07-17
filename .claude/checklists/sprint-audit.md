# Checklist: sprint 审计（每 sprint 一次，人类主持）

> 绑定 spec：specs/loops/spec.md。本清单承载全部 oracle:manual 子句——
> 它们不可机器判定，是人类作为系统意图最终责任人的固定介入点（VISION §三.6）。

sprint: ________  日期: ________

## 运行 audit loop

- [ ] `.claude/workflows/urtext-spec-audit.js` 已执行，四透镜 findings JSON 已产出
- [ ] critical / high findings 已去重并归档 issue；触及 P3 执法或 human gate 的
      critical 已当面裁决，不留过夜
- [ ] 抽 2 条 findings 核对 `ran` 字段：命令真实可重跑，结果一致（clause: C403）

## manual 子句逐条复核

- [ ] **C101 裁判永远是运行结果**：本 sprint 无任何"LLM 打分即通过"路径混入 loop 或 CI；
      跨模型对抗只用于元层（审证据覆盖），未替代证据本身
- [ ] **C103 事故回写脚手架**：本 sprint 每个 loop 事故都已回写为 PREAMBLE/协议规则
      并附 issue 号；翻查本 sprint 的 incident issue 逐一对照
- [ ] **C202 AREAS 地图人写人审**：深度提示仍然成立、已知 bug 排除项与
      issue 状态同步（已修复的移出）、新落地模块已增补领域条目
- [ ] **C504 模型路由是人类决策**：find 便宜 / fix 强 / 集成最强无未记录的变更；
      有变更则决策记录已落库

## 健康度（clause 体系自身，VISION P9）

- [ ] `urtext verify` 全绿（任一 fail 即 exit 1）
- [ ] manual oracle 占比 < 50%（`urtext verify` 输出末行 manual share）；
      连续两个 sprint 超线 → 停止扩建，升级讨论
- [ ] 本 sprint 新写子句均有 oracle；无 oracle 的规范性陈述按 P1 视为错误处理
