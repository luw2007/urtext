# Implementation notes — review UI (`urtext ui`)

Plan: `docs/plans/urtext-20260717-review-ui.md`. Records decisions & tradeoffs the plan/spec did not spell out.

## 决策与偏差

1. **命令名 `ui`（非 `review`）**：`urtext review` 已被占用（高危 clause 的 code review，cli.ts）。为避免语义冲突，浏览器裁决面板命名 `urtext ui`。

2. **数据源 = `adjudicate()` 而非 `verifyWorkspace()`**：这是修掉实验版 P0 的关键。`verifyWorkspace` 对 manual oracle 的 evidence verdict 恒为 `pending`（oracle-runner.ts），与是否已裁决无关。真正合并 Decision ledger 得出终态的是 `gate.ts` 的 `adjudicate()` —— 页面读它的 `decisionVerdict`，已裁决行才能显示 pass/fail 并移除按钮。双模型（sonnet-5 / gpt-5.6-sol）隔离评审一致命中了实验版这个盲区。

3. **`ui` 在 `run()` 之外的独立异步入口**：`run()` 是同步、finally 里 `db.close()`。`ui` 长驻、db 生命周期 = 整个评审会话，故在 entrypoint `process.argv[2] === 'ui'` 分支走 `runUi()`，持有 db 直到 SIGINT 才关。

4. **tsconfig 升 ES2023 → ES2024**：项目规则要求 `Promise.withResolvers()` 替代 `new Promise(executor)`；该 API 需 lib ES2024。Node engines ≥22 运行时支持。仅升 target/lib，无其它影响。

5. **P8 和解（写入 command-reference + 此处）**：`urtext ui` 是**交互会话期间存在的前台进程**，Ctrl-C 即完全消失，不 fork / 不 pid 文件 / 不自启 —— 与 `git rebase -i` 唤起编辑器同构，不是 P8 所禁的"常驻 runtime / orchestration model"。裁决落真实 Decision ledger，与 `urtext decide` 走同一 `recordDecision`，无第二事实源（C104）。

6. **安全（本地单人但仍加固，采纳 sol 评审）**：仅绑 `127.0.0.1`；每会话随机 CSRF token（页面 `<meta>` 注入，POST 需 `x-csrf` header）；校验 loopback Host + same-origin；要求 `content-type: application/json`；body 上限 4096；顶层 try/catch → 400/415/413/500，畸形请求不崩进程。写回复用 `recordDecision` 守卫（非 manual 子句被拒 P2、裁决绑 HEAD sha）。

7. **C006 裁决绑 HEAD，commit 后需重记**：加 `ui` 命令触发 C006「命令集变更需人工确认」（manual）。已 `urtext decide specs/urtext/spec.md#C006 --pass` 记录一次，但该 decision 绑当时 HEAD `87c34f2`。**本次 commit 后 HEAD 变，C006 decision 变 stale**——这是 urtext 正常语义（代码变了确实该重新确认命令集）。commit 后如需 `urtext gate` 全绿，需在新 HEAD 重记一次 C006。

## 已知边界

- `ui-server.ts` 的 socket IO 壳未单测（纯逻辑 `review-ui.ts` 全覆盖 + 一次手动冒烟覆盖端到端）。
- 未加 rate-limit / 会话超时：本地单人一次性评审，YAGNI。
- 浏览器自动打开用 `open`(macOS)/`xdg-open`(Linux)，失败非致命（打印 url 兜底）。Windows 未处理。
