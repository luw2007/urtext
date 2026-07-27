# Urtext 需求层(FR) — 最终裁决方案(Owner synthesis)

> 本文件是构建契约。基底 = Plan A(`urtext-20260726-req-layer-plan-opus.md`,以下称 A),
> 按下列修正案覆盖。冲突时:本文件 > A > Plan B(`urtext-20260726-req-layer-plan-codex.md`,以下称 B)。
> 攻击证据:`.urtext/attack-on-opus.md`(Codex 攻 A)、`.urtext/attack-on-codex.md`(Opus 攻 B)。
> Pinned contract(`docs/plans/urtext-20260726-req-layer-brief.md`)仍然全部有效。

## 裁决总表

| # | 争点 | 裁决 | 采纳 |
|---|---|---|---|
| 1 | 旧注册表语义升级 | `revisions` 增 `grammar_version` 列(ALTER ADD COLUMN DEFAULT 0);`indexClauseFile` 仅当 `content_hash` 与 `grammar_version` 双匹配才 no-op;新 parser 写 version 1。历史行不改写 | B 1.3 |
| 2 | 存储投影 | `clauses` 增 `reqs TEXT NOT NULL DEFAULT '[]'`(与 `refs` 列对称)+ 规范化 `clause_reqs` 边表;边表 FK 父键 `(spec_path, revision)`(与既有 clause_refs 一致——不引入对 clauses PK 的新 FK 形态,保持 schema 同构) | B 1.2(FK 从 A) |
| 3 | requirements 表 | A §1.1 原样(共用修订链、分表存储、`to_spec=''` 哨兵) | A |
| 4 | 空/坏 `req:` 错误码 | 缺失字段 → `missing_requirement`;字段存在但值空/坏 → 仅 `malformed_req`,不叠加。**尾逗号行为与 refs 完全一致(静默容忍)**——pinned contract 2 "mirrors refs grammar exactly" | B 2.3 + attack-M5 |
| 5 | 重复 req token | parser 首现序去重(parser 输出与落库一致) | B 2.2 |
| 6 | 同文件重复 FR id | 解析错误 `duplicate_req_id` → building(与 duplicate_clause_id 同策) | A |
| 7 | 同 unit 跨文件重复 FR id | **不扇出**。check 阶段 `ambiguous_req`(LinkError,独立错误码,与解析期 `duplicate_req_id` 分开——修 B 的 M4 单码双形状问题),退出 1;覆盖率上 ambiguous 绑定不计入 covered | B 4.2 精神,命名重修 |
| 8 | `unknown_req` 机器可读性 | 保持单一 `LinkError` 形状(不改判别联合——B 的判别联合被实证破坏 cli.ts strict 编译),**追加可选字段 `target?: string`** 携带缺失的 FR key;构造时始终赋值,cli.ts 零改动 | Owner 中间路线 |
| 9 | stale 传播模型 | B 4.3:FR 文本变更/删除时,**raw req 边直接命中的活跃子句进入 staleClauses 并作废证据(直接打戳,不经闭包源排除逻辑)**,再以这些子句为种子跑既有 clause_refs 反向闭包。删除 FR 用旧 key 匹配 raw 边(不能用现声明解析器找已删除的目标)。子句自身文本变更的既有语义不变(源不打戳)。同次提交"子句文本+其绑定 FR 文本"双变时,FR 直接命中集必须无条件打戳——不得被闭包 visited 集抑制(修 A blocker 4) | B |
| 10 | stale 崩溃窗口 | `propagateStale` 与修订落库同一 SQLite 事务(scanner 接线处显式包事务);不引入 outbox | Owner |
| 11 | status 形状 | A 判断 4:`uncoveredRequirements` 是报告区,**不进 items/counts.human/wip/退出码**;新增独立 `counts.uncovered` 字段;CLI status 在 lanes 循环后渲染未覆盖段(A §5.2);`--json` 同步携带。schema 就地扩展 `urtext.status/1`(仓内先例:urtext.check/1 增字段) | A(+counts.uncovered) |
| 12 | UI | **src/ui/ 零字节改动**(B 的 UI 表被实证引爆 ui-component-contrast manifest);UI 呈现推迟,写入 plan 的 deferred 清单 | A |
| 13 | brief | `reqs` 进 manifest 与 brief-hash(裁决上下文必须含需求绑定;两侧攻击均认同 B 漏此为错);brief 对 `unknown_req` 的拒绝文案给出 req 修复提示而非 unknown_ref 文案(修 A minor 9) | A + 修正 |
| 14 | FR 放置 | 语法层:FR heading 允许出现在任何位置(不发明顺序限制);迁移约定:FR 区块置于首条子句之前(避免截断子句 body 触发 stale 风暴)——写入 SYNTAX.md 为"建议",非错误码 | B 语法 + A 约定 |
| 15 | dogfood FR 草案 | 采用 A §8.3-8.7 全量草案(13/5/10,已实证 100% 绑定覆盖、零 phantom、零 dangling);granularity 品味争议不推翻已验证的完整性 | A |
| 16 | 自举子句 | A 的 C020-C023 + 新增 C024(grammar_version 迁移行为:旧库重扫、旧行不改写),oracle 绑 tests/registry.test.ts | A + B |
| 17 | distill 车道 | A §8.8(draft-template.md 增 `req:FR<n>`、scripts/oracle-skill.sh 增 `grep -q 'req:FR'`)**加** promote 渲染器修复:`src/distill.ts` 输出子句 anchor 必须保留 `req:` 字段(双方计划都漏;两侧攻击都抓到) | A + 双攻击 |
| 18 | fixture 迁移 | A §7.1 清单 + 两处双方都漏的:`src/verifier.ts` 内部构造的 clause 形状、`scripts/ui-acceptance-fixture.ts`;以 `tsc --noEmit` + 全测扫尾兜底 | A + 攻击补遗 |
| 19 | FR-only unit 警告文案 | clauseless 警告保留,但文案更新(FR 已是一等公民,"move it out of specs" 的旧建议改为"该 feature 尚无可执行锁") | B |
| 20 | 错误码全集 | 解析期:`missing_requirement` `malformed_req` `duplicate_req_id` `oracle_on_requirement` `risk_on_requirement`;check 期(LinkError):`unknown_req` `ambiguous_req`。SYNTAX.md 错误表按期分组 | 综合 |

## 实现顺序(单提交,不可 bisect——pinned contract 3 的代价,已接受)

1. `src/anchor.ts` 不动;`src/clause-parser.ts`(FR 类型/正则/parseReqs/错误码/主循环 FR 分支)
2. `src/registry.ts`(DDL:requirements、clause_reqs、clauses.reqs 列、revisions.grammar_version 列;对账逻辑;IndexOutcome 扩展)
3. `src/linker.ts`(liveGraph 扩展、resolveReq 单一权威、unknown_req/ambiguous_req、B 式 stale 传播、uncoveredRequirements)
4. `src/scanner.ts`(changedRequirements 接线,事务边界)
5. `src/status.ts` + `src/cli.ts`(uncovered 报告段与 counts.uncovered)
6. `src/brief.ts`(manifest.reqs 进 hash)
7. `src/distill.ts` promote 渲染器保留 req
8. 测试:A §7.2 新测试全集 + grammar_version 迁移测试 + 双变 self-stamp 测试 + ambiguous_req 测试
9. Fixture 迁移:A §7.1 清单 + 补遗
10. Dogfood:三个 spec.md 的 FR 草案与 req: 绑定(A §8.3-8.7)+ C020-C024 + tasks.md T016
11. `docs/SYNTAX.md`(Version evolution 表、FR 节、req 字段行、错误表、registry 节)
12. 收尾:`npx tsc --noEmit` → `npm test` → `node dist… urtext index && check && verify`(或仓内等价命令)全绿

## 验收(构建阶段的 definition of done)

- `npx tsc --noEmit` 干净(strict + exactOptionalPropertyTypes)
- 全测试套件绿(既有 + 新增)
- `urtext check` 在迁移后的本仓退出 0;人为制造 unmapped req/悬空 req 时退出 1
- `urtext status` 显示 0 uncovered;删除任一 clause 的 req 绑定后 uncovered 出现且退出码不变
- FR 文本改一字 → 绑定子句证据 `invalidated_at` 被打戳(含"子句+FR 双变"场景)
