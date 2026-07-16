# Checklist: fix-cycle 集成验收（每个 worker diff 一份）

> 绑定 spec：specs/loops/spec.md（C3xx fix / C5xx integrate）与 skill://integrate-worker。
> 执行人：集成者（最强模型或人类）。这是信任边界——worker 的一切声明视为未验证
> （clause: C102）。7 步顺序执行，不可跳步（clause: C501）。

worker key: ________  cycle: ____  日期: ________

## 逐步验收

- [ ] 1. 从新 trunk 建集成分支（非 worker 的 base）
- [ ] 2. `git apply --3way` 成功；冲突按意图解决并逐处记录
- [ ] 3. meta 中每个 `fixed` issue 的原始 repro 在 **trunk+diff** 上亲手重跑：由败转过
- [ ] 3b. 每个 `refuted` issue 有 PIN 测试且通过（clause: C301）
- [ ] 4. 与已合入/在途 worker 存在相互作用机制时，已当场编写跨机制组合测试；
       确无相互作用时勾选并注明依据
- [ ] 5. 全套测试 exit 0 + 格式化通过
- [ ] 6. commit 引用 `Fixes #NN` 每行一个
- [ ] 6b. meta.unmapped 逐条裁决：回写 spec 新子句，或 manual-ack 落决策记录
       （clause: C503；未裁决不得合入）
- [ ] 7. 弹回处理（如发生）：rebase 后保住两个 PR 语义，重跑双方 repro

## 车道纪律复核（clause: C502）

- [ ] 本 diff 未触碰热点清单文件；若触碰：确认同热点无并行在途 worker
- [ ] 本次集成暴露的新冲突磁铁已追加进 SKILL.md 热点清单

## 新能力覆盖（clause: C302）

- [ ] diff 新增的每个 oracle 类型 / 子句语法 / 检测路径，同 change 内有多用例覆盖
