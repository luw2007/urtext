# Checklist: hunt run 验收（每次夜间运行后）

> 绑定 spec：specs/loops/spec.md（C1xx 总则 / C2xx hunt）。
> 执行人：主 agent 归档、人类抽查。全部勾选（或标注 N/A + 理由）后本次 run 才算关闭。

## 机器可判部分（先跑，红则直接停）

- [ ] `urtext verify` exit 0（loops feature 全绿）
- [ ] coverage ledger 已更新本次扫描领域的日期（`.claude/workflows/hunt-ledger.json`）

## 每个归档 finding（clause: C201）

- [ ] repro 文件真实存在于 finding 记录的 `repro_path`
- [ ] `repro_command` 在当前 trunk 上手工重跑一次，观察结果与 `observed` 一致
- [ ] category 属于封闭枚举，不是风格/性能/诊断措辞问题（clause: C205）
- [ ] 已对现有 issue 去重，无平行 markdown backlog 产生（clause: C207）

## 抽查项（人类，每次 run 至少抽 1 条）

- [ ] 抽 1 条 verify 阶段 refuted 的 finding：refute 理由成立，不是 verifier 偷懒
- [ ] 本次 run 若有命令被权限防火墙拦截：拦截原因已回写为 SHELL SAFETY 新规则
      （clause: C105, C103）
