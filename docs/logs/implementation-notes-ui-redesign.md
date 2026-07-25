# Implementation notes — UI redesign, I3 slice (browser + evidence + docs)

Plan: `docs/plans/urtext-20260724-ui-redesign.md` §7.2 I3, §8. Prior slices:
I1 (`redesign/ui-security` → `418c5f1`-adjacent, renderer cutover + security
integration) and I2 (`418c5f1`, package exports + local-tool oracle/full-test
gates + tarball consumer proof). This file records I3-only decisions and
deviations; it is not a retroactive record of I1/I2 internals.

## 决策与偏差

1. **I3 不生成 final browser/evidence 产物**：`scripts/ui-browser-check.ts`、
   `scripts/ui-browser-check-wrapper.mjs`、`scripts/ui-evidence-manifest.ts`
   都是可执行 library，但本 slice 不调用它们对本仓库真实 Chrome/cmux 会话产出
   最终 receipt 或 manifest 文件——§7.2 明确该义务属于 MEC/trusted final gate
   (`BF` 阶段)，不属于 I3。`ui-evidence-manifest.ts` 的 `main()` 因此拒绝直接
   运行并打印一句说明，而不是静默写出一个看似"完成"的 evidence 文件。

2. **CDP script 显式端口/profile，不自行发现 Chrome**：`ui-browser-check.ts`
   只接受调用方传入的 `--port`/`--profile`/`--url`；启动 Chrome、创建隔离
   profile、解析 `DevToolsActivePort`、把端口显式转交是
   `ui-browser-check-wrapper.mjs` 唯一职责。两者拆分是为了让"谁负责启动
   Chrome"可单独审计，并让 `ui-browser-check.ts` 能在没有真实 Chrome 的
   Vitest 环境里对其纯函数逐一单测。

3. **纯校验函数与 live CDP orchestration 分层**：contrast/landmark/heading/AX
   label/keyboard focus/overflow/reduced-motion/progressive-disclosure/config
   threshold/diff-count/HTTP guard/sanitize 全部实现为无 I/O 纯函数并导出，
   `runCheckAtViewport` 只是把它们接到一次真实 CDP 会话上的胶水层。这样本
   slice 能提供扎实的 unit coverage，而不需要在 Vitest 里真的起 Chrome——真
   Chrome/cmux 冒烟仍是 orchestrator 用真实浏览器跑这些脚本时的职责，不由本
   session 断言"已通过"。

4. **evidence manifest 非自指化沿用 §5.2/P2 模式**：`assertNoSelfReference`
   拒绝 payload inventory 里出现 manifest 自身文件名或独立 digest sidecar
   文件名；`writeManifest` 把 manifest bytes 和 sha256 digest 写成两个独立
   文件，digest 内容对 manifest 最终字节重新计算，而不是从 manifest JSON 里
   读出来的字段。`verifyManifestDigest` 提供完整重算校验路径。

5. **六工具 preflight 是精确白名单，不是"至少六个"**：`assertSixTools`
   要求恰好 `node|git|npm|bun|cmux|chrome` 六个、无重复、每个都有绝对
   realpath 与非空 version；缺一或多一都 fail-closed。这直接对应计划 §5
   （P5 修订）"approved preinstalled platform tools" 的措辞，避免实现引入
   "无全局可执行"这个计划已经否决过的更严格误读。

6. **命令参考只描述已交付契约**：英中 `03-command-reference.md` 的新增段落
   只记录已经存在于 `src/ui/**`（I1 renderer cutover）里的行为——inline
   details 表单、All Specs、Code Blame Diff 折叠阈值环境变量、全路由 Host
   校验、light/dark/reduced-motion 样式——不描述本 slice 尚未执行的真实
   browser/AX 矩阵结果，避免文档先于证据。

7. **未交付项（有意，非疏漏）**：§8.3 描述的完整 cmux replay + Chrome CDP/AX
   12 场景矩阵、`tests/ui-component-contrast.test.ts` + committed
   `tests/ui-contrast-manifest.json`（计划 §5.2 J2 owner）、
   `scripts/ui-acceptance-server.ts`（§6.3 item 8）在本仓库历史里尚未出现
   （`git log`只有 I1/I2 两次集成提交），且不在本次「Change」清单范围内；
   I3 的边界任务只新增本文件列出的三个 browser/evidence 脚本、双语命令
   参考、静态/单元测试与本注记，不冒充执行了 §8.3 的真实浏览器矩阵。
