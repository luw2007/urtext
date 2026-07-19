# urtext review UI (`urtext ui`) — 完整实现 plan

- 日期：2026-07-17
- 定位：把实验版 `scripts/review-server.mjs` **转正**为永久 CLI 功能 `urtext ui`（用户选 A）。
- 一句话：`urtext ui` 起临时本地服务器 → 浏览器点击直接裁定 manual clause → 写真实 Decision ledger（`recordDecision` 守卫）→ `urtext gate/decisions` 立即认账。

## 目标与非目标

**目标**
1. 新命令 `urtext ui [--port N] [--no-open]`：起 `127.0.0.1` 临时前台 server，渲染 manual clause 评审面板，点击 pass/fail 直接写 `.urtext/registry.sqlite` 的 decisions 表。
2. 页面显示**真实裁决状态**：读 `adjudicate()`（合并 decision ledger），已裁决行显示 pass/fail 且按钮消失（根治评审 P0）。
3. 继承双模型评审的全部修复：try/catch 不崩、路由白名单、CSRF token、`data-*`+事件委托防 XSS、body 上限。
4. 与项目宪法和解：P8 注记 + C015/C006 门禁同步 + 测试 + 文档。

**非目标**
- 不做常驻 daemon、不后台化、不开机自启（P8 红线）。
- 不引前端框架/build（KISS，原生 fetch 足够）。
- 不做高危 clause 的 code review UI（那是 `urtext review` 的领域，本命令只管 manual `decide`）。
- 不改任何 loop spec 子句、不动业务模块。

## 宪法约束对照（每条都必须落）

| 约束 | 来源 | 落法 |
|---|---|---|
| P8 无 daemon | VISION.md:69 | 临时前台进程，Ctrl-C 即净；ADR 注记界定"交互会话进程 ≠ 常驻服务"，类比 `git rebase -i` 编辑器 |
| C104 单一事实源 | specs/loops/spec.md | 显示走 `adjudicate()`、写走 `recordDecision()`，不二次解析、不另立状态源 |
| P2 只 manual 人裁 | VISION | 复用 `recordDecision` 守卫（非 manual 子句被拒），页面按钮仅对 manual+未裁决出现 |
| C015 命令集覆盖 | specs/urtext/spec.md:82 | `scripts/oracle-wiki.sh:14` 命令循环加 `ui`；`docs/wiki/guides/03-command-reference.md` 加 `urtext ui` 段 |
| C006 命令集变更需人工确认 | specs/urtext/spec.md | 命令集变更后 `urtext decide specs/urtext/spec.md#C006 --pass` 一次 |

## 架构（可测优先，薄 server）

三个新单元，依赖单向 `cli → ui-core → {gate, decision, scanner, clause-parser}`，无环：

1. **`src/review-ui.ts`（纯逻辑，全可单测，零 IO）**
   - `buildUiSnapshot(db, root): UiSnapshot` — `scanWorkspace` 后调 `adjudicate(db, 0, head)`，取每个 clause 的 `clauseId/title/risk/oracleKind/decisionVerdict/reasons`；manual 且 `decisionVerdict==='none'` 标 `actionable:true`。
   - `renderPage(snapshot, csrfToken): string` — 纯字符串 HTML；已裁决行显示 pass/fail 状态、无按钮；actionable 行显示 `[✓ pass][✗ fail]`（`data-key`/`data-v`，无内联 onclick）；页面注入 `<meta name=csrf>`。
   - `handleDecide(db, root, input, decider): {status, body}` — 校验 `{key, verdict}`，拆 `specPath#clauseId`，调 `recordDecision`，映射 recorded→200 / rejected→400。
   - `UiSnapshot`/`UiClause` 类型。

2. **`src/ui-server.ts`（薄 IO 壳）**
   - `startUiServer(db, root, {port, open}): Promise<{url, close}>` — `node:http` 绑 `127.0.0.1`；每会话生成随机 `csrfToken`；路由白名单：`GET /`→`renderPage`、`POST /api/decide`（校验 Origin/Host loopback + `content-type: application/json` + header `x-csrf`）→`handleDecide`、其余→404；body>4096→413；顶层 try/catch→500。SIGINT→close。

3. **`src/cli.ts`（挂载，薄）**
   - `COMMANDS.ui = true`；USAGE 加行；`command === 'ui'` 块解析 `--port`/`--no-open`，`await startUiServer`，打印 url，保持前台直到 SIGINT。
   - `reviewerName()` 复用为 decider。

## 命令契约

```
urtext ui [--port <n>] [--no-open]
  起 127.0.0.1:<port|随机> 评审面板；默认自动开浏览器（--no-open 关闭）。
  前台阻塞，Ctrl-C 退出。退出码 0（正常退出）。
  写入：点击裁定 → .urtext/registry.sqlite decisions 表（经 recordDecision）。
```

## 测试计划（`tests/review-ui.test.ts`，:memory: DB + 构造子句，确定性隔离）

真契约，不测管道：
1. `buildUiSnapshot`：manual clause 已 `recordDecision(pass)` → `decisionVerdict:'pass'`、`actionable:false`；未裁决 → `'none'`、`actionable:true`；非 manual → 无按钮语义。
2. `buildUiSnapshot`：裁决绑 HEAD——decision 在旧 sha、当前 HEAD 变 → 该 clause 回到 actionable（复用 decisionsAtHead 语义）。
3. `renderPage`：actionable 行含 `data-v="pass"` button；已裁决行无 button 有状态标签；title 含 `<script>`/`'` → 输出无裸标签/无引号越界；含 csrf meta。
4. `handleDecide`：合法 manual → 200 且 ledger 新增一行；非 manual clause → 400（P2 守卫）；未知 clause → 400；缺字段/非法 verdict → 400。

（server IO 壳 `ui-server.ts` 的 socket 部分不单测，靠一次手动冒烟覆盖：起服务→点击→刷新反映→负例不崩→Ctrl-C 净退。）

## 门禁同步（同一逻辑单元，不可拆）

- `scripts/oracle-wiki.sh:14` 命令 for 循环加 `ui`（否则 C015 command-coverage fail）。
- `docs/wiki/guides/03-command-reference.md` 加 `### urtext ui` 段（"Human decisions" 节内）+ exit-code 表加行。
- 命令集变更后 `urtext decide specs/urtext/spec.md#C006 --pass "add ui command"` 记一次（C006 manual）。

## 交付物清单

**新增**：`src/review-ui.ts`、`src/ui-server.ts`、`tests/review-ui.test.ts`
**改动**：`src/cli.ts`（命令+USAGE+COMMANDS）、`src/index.ts`（export 类型）、`scripts/oracle-wiki.sh`、`docs/wiki/guides/03-command-reference.md`
**删除**：`scripts/review-server.mjs`（实验版转正后删除，避免两份并存）
**注记**：`docs/logs/implementation-notes-review-ui.md`（P8 界定、命令名冲突、决策）

## 阶段

- **Phase 1 核心**：`review-ui.ts` 纯逻辑（buildUiSnapshot/renderPage/handleDecide）+ 单测绿。
- **Phase 2 server+CLI**：`ui-server.ts` + cli 挂载；手动冒烟（起→点→刷新反映→负例→净退）。
- **Phase 3 门禁+文档**：oracle-wiki.sh + command-reference + index.ts export；C005/vitest/全 gates 绿；删实验版；C006 decide。
- **Phase 4 收尾**：implementation-notes；full gates `ALL GATES PASS`；commit。

## P8 和解声明（写入 implementation-notes + command-reference）

`urtext ui` 是**交互会话期间存在的前台进程**，Ctrl-C 即完全消失，不 fork、不 PID、不自启——与 `git rebase -i` 唤起编辑器同构。它不是 P8 所禁的"常驻 runtime / orchestration model"。裁决落真实 ledger，与 CLI `urtext decide` 走同一 `recordDecision`，无第二事实源。
