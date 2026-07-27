# Urtext UI 人类投影（P1–P5）— Plan A（Opus lane, round 3）

> Binding brief: `.urtext/ui-projection-brief.md`。其 "Pinned contract" 不可议；本文件负责数据管道、渲染架构、prompt 设计、迁移机制与测试策略，并为每个决策写明被否决的备选。
> 前置裁决：`docs/plans/urtext-20260724-ui-redesign.md`（状态词汇 / 静态 ID 注册 / a11y 门 / J2 manifest）、`docs/plans/urtext-20260727-fr-observability-plan-final.md`（round-2 全部裁决，尤其 #10 源哈希表、#11 branch 拆分、#12 manifest 再生成、#13 browser acceptance、MN-6 独立 oracle 文件）。

---

## 0. 事实基线（先读代码，再设计）

下列每一条都来自本仓库当前代码，不是推测。它们是后面所有决策的地基。

| # | 事实 | 证据 |
|---|---|---|
| F1 | `evidence` 表当前唯一可变列是 `invalidated_at`；schema 与 additive 迁移都在 `verifier.ts`，不在 `registry.ts`。**并发提醒**：verify-perf 车道已在同一处落了 `input_fingerprint TEXT` 列（工作树未提交），本轮必须在其之后追加，不得覆盖 | `src/verifier.ts:18-55`（含未提交改动） |
| F2 | `openRegistry` 的迁移范式 = `pragma_table_info` 探测 + `ALTER TABLE … ADD COLUMN`（`grammar_version` 即如此落地） | `src/registry.ts:147-166`，尤其 `:162-164` |
| F3 | `propagateStale` 用 **一条** `UPDATE evidence SET invalidated_at = ? WHERE … AND invalidated_at IS NULL` 打戳，整体包在 `db.transaction` 内，并且被 scanner 的外层事务再包一层 | `src/linker.ts:331-340`、`src/scanner.ts:126,132-133` |
| F4 | `reverseClosure` 是纯 key BFS，被 `propagateStale` / `impact` / `impactRequirement` 三处共用；`impact` 的 CLI 输出必须逐字不变（brief pinned #8） | `src/linker.ts:263-287,328,351,389` |
| F5 | **stale 子句永远在 agent 车道**：`AGENT_ORDER` 含 `'stale'`，`lane` 只要命中任一 agent reason 就是 `'agent'` | `src/status.ts:43,126` |
| F6 | stale ⟹ 该子句必有一行 evidence（打戳只改已存在行），故 `evidenceVerdict ∈ {pass,fail,pending}`，`primary ∈ {'evidence_failing','stale'}` | `src/linker.ts:331-334` + `src/status.ts:103-125` |
| F7 | `UiClause` 只透传 7 个字段，**没有** `auditVerdict` / `reviewStatus`；而 `ClauseDecision` 两者都有 | `src/review-ui.ts:42-53,80-92` vs `src/gate.ts:27-42` |
| F8 | `decisionVerdict === 'n/a'` ⟺ 非 manual oracle（gate 只对 manual 填值），即"可被元审计"的等价判据 | `src/gate.ts:153-157` |
| F9 | console 每个路由**只能有一个 `<table>`**（既有测试硬断言），round-2 正因此把 Uncovered intent 做成 `<ul>` | `tests/ui-console.test.ts:202` + final plan `:20` |
| F10 | `SpecImpactView` **不带 `refs`**，`impact` 是反向传递闭包不是一跳；一跳依赖当前无任何来源 | `src/ui/contracts.ts:77-91`、`src/linker.ts:349-357` |
| F11 | `handleBrief` 已经构建了 `decisionByKey`（一次 `adjudicate`），可零成本富化任意 clause key | `src/review-ui.ts:241-251` |
| F12 | explain 控件只在 `reviewable === true` 的 brief 页渲染，脚本也只在此注入 | `src/ui/render-brief.ts:199,207` |
| F13 | `/api/explain` 已在 POST 安全链内：Host → Origin → CSRF → media-type → body-cap(4096B) → JSON.parse → handler | `src/ui-server.ts:101,247-282,316-331` |
| F14 | 源哈希表已是 **8 个文件**（round-2 已把 `contracts.ts` 补进两套实现） | `tests/ui-component-contrast.test.ts:83-92`、`scripts/ui-browser-check.ts:112-121` |
| F15 | manifest 现有 15 fixture / 32 consumer；三个 queue 路由 fixture 的 `snapshot.clauses` 全为 `[]`；唯一的 stale item 在 `agent-busy` 的第 3 条，而该 fixture `pageSize=2, page=1` —— **它根本没被渲染** | `tests/ui-contrast-manifest.json`（实测 jq 枚举） |
| F16 | `captureFocusOrder` 用 `e.id \|\| e.tagName.toLowerCase()` 当身份，`validateFocusOrder` 把重复身份判为错误；而 `appNav` 渲染 5 个无 id 的 `<a>` | `scripts/ui-browser-check.ts:751-765,217-226`、`src/ui/render-console.ts:44-51` |
| F17 | acceptance fixture 5 条子句里**没有任何 stale**，`worktree` 结束时必须干净 | `scripts/ui-acceptance-fixture.ts:30-49,184-187` |
| F18 | `status --json` = `JSON.stringify(report)`，文本渲染只读 `primary/reasons/next/risk/title` | `src/cli.ts:416-418,432-439` |
| F19 | `handleExplain/handleReview/handleAuditRun` **不在** `src/index.ts` 导出面上 | `src/index.ts:113-128` |

F5 是本轮最重要的发现：pinned #1 写的是"每个 human/agent 车道的 stale item"，而现实是 **stale item 只可能出现在 agent 车道**。因此因果句必须实现在 `queueRow`（两个表共用的行渲染器），它自动满足合同；但可见分支只在 `/agent` 上可达。本计划不假装 `/` 会显示它。

F15 意味着：不新增 fixture 就没有任何 stale 行被渲染，P1 的对比度分支不可达。

F16 是一个**先于本轮存在**的浏览器门缺陷（见 §7.4），本轮必须处理，否则"browser acceptance 全绿"是不可能兑现的承诺。

---

## 1. P1 因果链：数据模型、迁移、传播、组句

### 1.1 列迁移（`src/verifier.ts`）

`invalidation_source` 属于 evidence 账本，schema 与迁移都跟 `invalidated_at` 同居一处。当前工作树里 verify-perf 车道已经在这两处各加了一条 `input_fingerprint`（`src/verifier.ts:32,52-54`）；下面给的是**在其之后追加**的最终形态，两条列互不相干、两条迁移互相幂等。

```ts
export const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  oracle_kind TEXT    NOT NULL,
  oracle_ref  TEXT,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('pass', 'fail', 'pending')),
  exit_code   INTEGER,
  output      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  duration_ms INTEGER,
  invalidated_at INTEGER,
  input_fingerprint TEXT,
  invalidation_source TEXT
);
`

/**
 * Evidence is append-only except ONE invalidation stamp, written as a single
 * mutation: `invalidated_at` (when) plus `invalidation_source` (the key whose
 * change voided it — `<path>#C<n>` or `<path>#FR<n>`). The linker writes both
 * columns in the same UPDATE; nothing else ever writes either. Rows stamped
 * before this column existed keep `invalidation_source = NULL`, which the UI
 * renders as an unattributed upstream change — never a fabricated culprit.
 * Includes the additive migrations for M1-era ledgers.
 */
export const ensureEvidenceLedger = (db: Database): void => {
  db.exec(EVIDENCE_SCHEMA)
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info('evidence')`)
    .all() as { name: string }[]
  if (!columns.some((column) => column.name === 'invalidated_at')) {
    db.exec('ALTER TABLE evidence ADD COLUMN invalidated_at INTEGER')
  }
  if (!columns.some((column) => column.name === 'duration_ms')) {
    db.exec('ALTER TABLE evidence ADD COLUMN duration_ms INTEGER')
  }
  if (!columns.some((column) => column.name === 'input_fingerprint')) {
    db.exec('ALTER TABLE evidence ADD COLUMN input_fingerprint TEXT')
  }
  if (!columns.some((column) => column.name === 'invalidation_source')) {
    db.exec('ALTER TABLE evidence ADD COLUMN invalidation_source TEXT')
  }
}
```

- **决策**：可空 `TEXT`、无 `DEFAULT`。*被否决的备选*：`NOT NULL DEFAULT ''` —— 空串会把"历史行未知"与"来源为空"混成同一个值，UI 就无法诚实地降级。
- **决策**：迁移放 `ensureEvidenceLedger` 而非 `openRegistry`。*被否决的备选*：放 `openRegistry` —— evidence 表根本不属于 `REGISTRY_SCHEMA`，且 `openRegistry` 不是 verify/gate/brief 路径的必经点（`src/verifier.ts:104`、`src/gate.ts:83`、`src/brief.ts:192` 各自调 `ensureEvidenceLedger`）。
- 无 `.urtext/registry.sqlite` 重建、无数据回填：pinned #1 明确 legacy 行留 NULL。
- **与 verify-perf 的交叉检查（已实测）**：增量复用在 `src/verifier.ts:202` 显式 `if (row.invalidated_at !== null) continue`，作废行永远不会被当作新鲜证据复用；复用路径不 INSERT 新行，因此一条被作废的子句只能靠真正重跑来清 stale。两条语义正交，本轮不需要动它，但实施时必须复核该守卫仍在（它是 P1 与 P2 全部计数的前提）。

### 1.2 传播归因（`src/linker.ts`）

难点在于：`staleClauses` 是 "FR 直接命中集 ∪ refs 反向闭包"，而闭包的种子里既有 **文本变更的子句**（culprit = 它自己），又有 **FR 直接命中的子句**（culprit = 那条 FR，它自己的文本并没有动）。把 culprit 记成"闭包上一跳"会直接说谎。

保留 `reverseClosure` 的遍历顺序不动（F4：既有 linker 测试逐数组断言），只把它包成带标签的版本：

```ts
/** A clause marked stale, tagged with the key whose change actually caused it. */
interface StaleSeed {
  clause: ClauseKey
  /** `<path>#C<n>` (a clause's text moved) or `<path>#FR<n>` (an intent moved). */
  source: string
}

/**
 * Reverse transitive closure (BFS) of `seeds` over the live refs graph, carrying
 * each seed's source down to everything it reaches. First writer wins, in seed
 * order — a dependent five hops down still names the key that actually changed,
 * not its immediate parent.
 */
const reverseClosureFrom = (edges: RefEdge[], seeds: readonly StaleSeed[]): StaleSeed[] => {
  const dependents = new Map<string, ClauseKey[]>()
  for (const edge of edges) {
    const target = keyOf(edge.to_spec, edge.to_clause)
    const list = dependents.get(target) ?? []
    list.push({ specPath: edge.spec_path, clauseId: edge.clause_id })
    dependents.set(target, list)
  }

  const visited = new Set(seeds.map((seed) => keyOf(seed.clause.specPath, seed.clause.clauseId)))
  const queue = [...seeds]
  const closure: StaleSeed[] = []
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    if (current === undefined) continue
    for (const dependent of dependents.get(keyOf(current.clause.specPath, current.clause.clauseId)) ?? []) {
      const key = keyOf(dependent.specPath, dependent.clauseId)
      if (visited.has(key)) continue
      visited.add(key)
      const next: StaleSeed = { clause: dependent, source: current.source }
      closure.push(next)
      queue.push(next)
    }
  }
  return closure
}

/** Key-only closure — the shape `impact`/`impactRequirement` consume, unchanged. */
const reverseClosure = (edges: RefEdge[], sources: ClauseKey[]): ClauseKey[] =>
  reverseClosureFrom(
    edges,
    sources.map((clause) => ({ clause, source: '' }))
  ).map((seed) => seed.clause)
```

- **决策**：泛化 BFS + 一行 key-only 包装。*被否决的备选*：在 `propagateStale` 里另写一份带归因的 BFS —— 20 行 BFS 复制两份，将来一处修一处漏正是 stale 传播最不能承受的 bug 类型。

`propagateStale` 改写（顺序与既有实现逐步对齐，`staleClauses` 数组逐字不变）：

```ts
/**
 * Mark every dependent of `changed` stale by stamping its live evidence with ONE
 * invalidation stamp — `invalidated_at` + `invalidation_source`, written in the
 * same UPDATE. The changed clauses themselves need no stamp: their text change
 * already minted a new revision, so verify re-runs them regardless. A clause hit
 * directly by a changed requirement IS stamped (its own text did not move, its
 * intent did) and is attributed to that requirement, not to itself.
 */
export const propagateStale = (
  db: Database,
  changed: ClauseKey[],
  timestamp: number,
  changedRequirements: RequirementKey[] = []
): StaleReport => {
  if (changed.length === 0 && changedRequirements.length === 0) {
    return { staleClauses: [], invalidatedEvidence: 0 }
  }
  ensureEvidenceLedger(db)
  const graph = liveGraph(db)
  const uniqueSeeds = (seeds: StaleSeed[]): StaleSeed[] => {
    const seen = new Set<string>()
    return seeds.filter((seed) => {
      const key = keyOf(seed.clause.specPath, seed.clause.clauseId)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const matchesChangedRequirement = (edge: ReqEdge, requirement: RequirementKey): boolean => {
    if (edge.to_req !== requirement.reqId) return false
    if (edge.to_spec !== '') return edge.to_spec === requirement.specPath
    const sourceFeature = featureOf(edge.spec_path)
    return sourceFeature !== null && sourceFeature === featureOf(requirement.specPath)
  }
  const directRequirementDependents = uniqueSeeds(
    graph.reqEdges.flatMap((edge) => {
      const requirement = changedRequirements.find((candidate) =>
        matchesChangedRequirement(edge, candidate)
      )
      return requirement === undefined
        ? []
        : [
            {
              clause: { specPath: edge.spec_path, clauseId: edge.clause_id },
              source: keyOf(requirement.specPath, requirement.reqId),
            },
          ]
    })
  )
  const changedSeeds: StaleSeed[] = changed.map((clause) => ({
    clause,
    source: keyOf(clause.specPath, clause.clauseId),
  }))
  const roots = uniqueSeeds([...changedSeeds, ...directRequirementDependents])
  const downstream = reverseClosureFrom(graph.edges, roots)
  const staleSeeds = uniqueSeeds([...directRequirementDependents, ...downstream])

  const invalidate = db.prepare(
    `UPDATE evidence SET invalidated_at = ?, invalidation_source = ?
     WHERE spec_path = ? AND clause_id = ? AND invalidated_at IS NULL`
  )
  let invalidatedEvidence = 0
  db.transaction(() => {
    for (const seed of staleSeeds) {
      invalidatedEvidence += invalidate.run(
        timestamp,
        seed.source,
        seed.clause.specPath,
        seed.clause.clauseId
      ).changes
    }
  })()
  return { staleClauses: staleSeeds.map((seed) => seed.clause), invalidatedEvidence }
}
```

三条不变量，逐条可测：

1. **顺序不变**：`roots` = `[...changedSeeds, ...directRequirementDependents]` 与原 `[...changed, ...directRequirementDependents]` 一一对应；`staleSeeds` = `[...directRequirementDependents, ...downstream]` 同理。既有 `tests/linker.test.ts:141-245` 的逐数组断言全部继续成立。
2. **同一子句既文本变更又被 FR 命中**（round-1 final #9 要求它必须打戳）：`staleSeeds` 里 `directRequirementDependents` 在前，去重保留 FR 来源 → **戳的是 FR**；而 `roots` 去重保留 `changedSeeds` 在前 → **它的下游继承子句自身 key**。两条规则天然正交，正是语义上正确的组合。
3. **一次写入两列**：SQL 里 `invalidated_at` 与 `invalidation_source` 同一条 `UPDATE`、同一个 `WHERE invalidated_at IS NULL` 幂等守卫。文档一律称其为"一枚 invalidation 印章（两列）"。

- **决策**：`StaleReport` 形状不动（不把 source 带出去）。*被否决的备选*：把 `staleClauses` 改成 `StaleSeed[]` —— 那是导出类型的破坏性变更（`src/index.ts:42`），而当前没有任何消费者需要它；UI 从 evidence 表读，路径更短也更真。
- **决策**：多条 changed FR 命中同一子句时取 `changedRequirements` 中的第一条匹配（`.find`）。*被否决的备选*：取字典序最小的 FR key —— 需要额外排序，且"先声明的那条"和"字典序最小的那条"同样任意，前者与既有 `.some()` 判据完全同源、diff 更小。

### 1.3 gate 透出（`src/gate.ts`）

```ts
interface EvidenceState {
  verdict: 'pass' | 'fail' | 'pending'
  stale: boolean
  /** The key whose change voided this evidence; null for rows stamped before
   * the source column existed, and for evidence that is not stale at all. */
  invalidationSource: string | null
}

/** Latest evidence verdict + stale flag + invalidation source per clause. */
const evidenceByClause = (db: Database): Map<string, EvidenceState> => {
  ensureEvidenceLedger(db)
  const rows = db
    .prepare(
      `SELECT e.spec_path, e.clause_id, e.verdict, e.invalidated_at, e.invalidation_source
       FROM evidence e
       JOIN (
         SELECT spec_path, clause_id, MAX(id) AS id
         FROM evidence GROUP BY spec_path, clause_id
       ) latest ON latest.id = e.id`
    )
    .all() as {
    spec_path: string
    clause_id: string
    verdict: 'pass' | 'fail' | 'pending'
    invalidated_at: number | null
    invalidation_source: string | null
  }[]
  const map = new Map<string, EvidenceState>()
  for (const row of rows) {
    map.set(`${row.spec_path}#${row.clause_id}`, {
      verdict: row.verdict,
      stale: row.invalidated_at !== null,
      // Source is only meaningful under a real stamp — never surface a stray value.
      invalidationSource: row.invalidated_at === null ? null : row.invalidation_source,
    })
  }
  return map
}
```

`ClauseDecision` 增一个必填字段（只有 `adjudicate` 构造它，加必填字段不破坏任何读侧）：

```ts
export interface ClauseDecision {
  // …既有字段不动…
  stale: boolean
  /** The key whose change voided this clause's evidence; null when not stale
   * or when the stamp predates the source column. */
  invalidationSource: string | null
  // …
}
```

`adjudicate` 循环内：`const invalidationSource = state?.invalidationSource ?? null`，并在 `decisions.push({...})` 中紧随 `stale` 之后写入。gate 的裁决逻辑一个字节不动 —— 来源是审计元数据，不是判据。

### 1.4 status 透出（`src/status.ts`）

```ts
export interface StatusItem {
  // …既有字段不动…
  risk?: 'low' | 'high'
  /** For a stale clause: the key whose change voided its evidence. Absent for
   * non-stale items and for legacy stamps with no recorded source. */
  invalidationSource?: string
  filePath?: string
  // …
}
```

`clauseItem` 里，只在"真的 stale 且真的有来源"时才带上（`exactOptionalPropertyTypes` 下用条件展开，与仓内既有写法一致，见 `src/review-ui.ts:318-319`）：

```ts
return {
  key: `${decision.specPath}#${decision.clauseId}`,
  kind: 'clause',
  lane,
  primary,
  reasons: ordered,
  next: NEXT_HINT[primary],
  specPath: decision.specPath,
  clauseId: decision.clauseId,
  title: decision.title,
  risk: decision.risk,
  ...(decision.stale && decision.invalidationSource !== null
    ? { invalidationSource: decision.invalidationSource }
    : {}),
}
```

CLI 影响：`status` 文本渲染只读 `primary/reasons/next/risk/title`（F18），逐字节不变；`--json` 是整体 `JSON.stringify`，自动携带可选字段 —— 正是 pinned #8 允许的"仅新增可选字段，schema `urtext.status/1` 就地扩展"。

### 1.5 组句位置：渲染层，不是 status 层

**决策**：因果句在 `src/ui/render-console.ts` 组装，status 只提供事实（`invalidationSource` + 既有 `reasons/key`）。
*被否决的备选*：在 `status.ts` 里生成整句（`NEXT_HINT` 式的常量表）—— contrast manifest 的 `sourceContractSha256` 只哈希 `src/ui/*` 八个文件（F14），而 fixture 里的 `snapshot` 是字面量：句子若在 status 层生成，fixture 会存下**已经拼好的句子**，此后改文案既不动源哈希也不动渲染哈希，J2 门对这段文案彻底失明。放渲染层则 fixture 只存事实、句子由渲染现场生成，两个哈希都覆盖它。

```ts
/**
 * P1 causal chain — one sentence per stale queue row: what changed, what it
 * voided, and what that costs right now. Composed HERE (not in status.ts) so the
 * contrast manifest's render hash covers the copy itself: fixtures carry facts,
 * never pre-composed prose.
 *
 * The tail is deliberately not a prediction. A HEAD-bound review (gate.ts:141-148)
 * or manual decision (gate.ts:153-157) survives re-verification, so "重跑后需重审"
 * is false for some clauses; "重跑 verify 前不放行" is true for every stale clause
 * by construction (gate.ts:166 always pushes a reason ⇒ decision = 'human').
 */
const causalLine = (item: StatusItem): string => {
  if (!item.reasons.includes('stale')) return ''
  const culprit =
    item.invalidationSource === undefined
      ? '上游变更'
      : `<code>${esc(item.invalidationSource)}</code> 文本变更`
  return `<p data-causal="${esc(item.key)}">${statusChip('warn', '⚠', '因果链', 'causal')} ${culprit} → <code>${esc(
    item.key
  )}</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行</p>`
}
```

挂载点：`queueRow` 的"阻塞原因"单元格，紧跟 primary/secondary 之后（`<p>` 在 `<td>` 内合法）：

```ts
return `<tr data-row="${esc(item.key)}"><td>${esc(item.key)}${title}${risk}</td><td>${esc(
  item.primary
)}${secondary}${causalLine(item)}</td><td>${action}</td></tr>`
```

因为 `queueRow` 同时服务 `/`（human）与 `/agent`（agent），pinned #1 的"每个 human/agent 车道 item"被机械满足；按 F5，实际可达面是 `/agent`。

---

## 2. P2 Feature health header：聚合与渲染

### 2.1 数据缺口与最小补法

四个格子需要：证据判定（有）、元审计一致（**缺**）、高危已批准/总数（**缺**）、未覆盖意图（有，来自 `status.uncoveredRequirements`）。

**决策**：`UiClause` 增两个直通字段 `auditVerdict` / `reviewStatus`，来源就是 `ClauseDecision` 的同名字段。
*被否决的备选*：从 `status.items` 的 reason 反推 —— 自动通过的子句**根本不产生 item**（`src/status.ts:124`），分母会静默丢掉所有健康子句，这个 header 就会在最健康的仓库里显示最差的数字。

```ts
export interface UiClause {
  specPath: string
  clauseId: string
  title: string
  risk: 'low' | 'high'
  decisionVerdict: 'pass' | 'fail' | 'none' | 'n/a'
  evidenceVerdict: 'pass' | 'fail' | 'pending' | 'missing'
  /** Cross-model meta-audit verdict on the latest evidence. */
  auditVerdict: 'agree' | 'disagree' | 'unaudited'
  /** Human code-review status at the current HEAD; `n/a` for low-risk clauses. */
  reviewStatus: 'approved' | 'rejected' | 'none' | 'n/a'
  stale: boolean
  actionable: boolean
}
```

`buildUiSnapshot` 里逐字段透传即可（`src/review-ui.ts:80-92` 的 map 内加两行）。

### 2.2 聚合（`src/ui/render-console.ts`）

**决策**：聚合写在渲染器，`UiSnapshot` 不加 `featureHealth` 字段。
*被否决的备选*：在 `review-ui.ts` 里算好挂到 snapshot 上 —— 那样 15 个 fixture 会存下**算好的行**，聚合算错时两个哈希都不变；且这是纯显示投影，没有理由污染 domain snapshot（pinned #2："Render-only"）。

```ts
const FEATURE_PATH = /^specs\/([^/]+)\//

/** `specs/<feature>/…` → `<feature>`; anything else groups under its own path. */
const featureOf = (specPath: string): string => specPath.match(FEATURE_PATH)?.[1] ?? specPath

interface FeatureHealthRow {
  feature: string
  total: number
  evidencePass: number
  /** pass + fail — pending/missing are undecided, not failures (verifier.ts:63). */
  evidenceDecided: number
  auditAgree: number
  /** Runnable-oracle clauses; manual ones have no meta-audit (gate.ts:170). */
  auditable: number
  highRiskApproved: number
  highRisk: number
  uncovered: number
}

/**
 * P2 aggregation — one row per feature unit, from the SAME adjudication data the
 * queue already renders (`adjudicate` → UiClause) plus the status report's
 * uncovered requirements. Nothing here enters items, counts, WIP, or an exit code.
 */
const featureHealthRows = (snapshot: UiSnapshot): FeatureHealthRow[] => {
  const rows = new Map<string, FeatureHealthRow>()
  const rowFor = (specPath: string): FeatureHealthRow => {
    const feature = featureOf(specPath)
    const existing = rows.get(feature)
    if (existing !== undefined) return existing
    const created: FeatureHealthRow = {
      feature,
      total: 0,
      evidencePass: 0,
      evidenceDecided: 0,
      auditAgree: 0,
      auditable: 0,
      highRiskApproved: 0,
      highRisk: 0,
      uncovered: 0,
    }
    rows.set(feature, created)
    return created
  }

  for (const clause of snapshot.clauses) {
    const row = rowFor(clause.specPath)
    row.total += 1
    if (clause.evidenceVerdict === 'pass' || clause.evidenceVerdict === 'fail') {
      row.evidenceDecided += 1
      if (clause.evidenceVerdict === 'pass') row.evidencePass += 1
    }
    // `decisionVerdict === 'n/a'` ⟺ runnable oracle ⟺ meta-audited (gate.ts:153-157,170).
    if (clause.decisionVerdict === 'n/a') {
      row.auditable += 1
      if (clause.auditVerdict === 'agree') row.auditAgree += 1
    }
    if (clause.risk === 'high') {
      row.highRisk += 1
      if (clause.reviewStatus === 'approved') row.highRiskApproved += 1
    }
  }
  // A feature can have uncovered intent and zero live clauses — it still gets a row.
  for (const requirement of snapshot.status.uncoveredRequirements) {
    rowFor(requirement.specPath).uncovered += 1
  }
  return [...rows.values()].sort((left, right) => left.feature.localeCompare(right.feature))
}
```

### 2.3 渲染

**决策**：`<ul>` 而非 `<table>`。
*被否决的备选*：`<table>` —— `tests/ui-console.test.ts:202` 硬断言每个路由恰好一个列表 table（F9），round-2 的 Uncovered intent 正因同一条约束选了 `<ul>`（final plan `:20`）；为一块只读表头去改这条不变量，是拿掉一个真正在防回归的守卫。

```ts
/** `n/m` with a three-channel chip; `denominator === 0` renders "不适用",
 * never a fake 100% (D2: an empty denominator is not a green result). */
const healthCell = (label: string, numerator: number, denominator: number): string => {
  if (denominator === 0) return `${esc(label)} ${statusChip('muted', '—', '不适用')}`
  const complete = numerator === denominator
  return `${esc(label)} ${statusChip(complete ? 'ok' : 'warn', complete ? '✓' : '⚠', `${numerator}/${denominator}`)}`
}

const featureHealthRow = (row: FeatureHealthRow): string =>
  `<li data-feature="${esc(row.feature)}"><a href="/specs">${esc(row.feature)}</a> <small>(${
    row.total
  } 条)</small> ${healthCell('证据', row.evidencePass, row.evidenceDecided)} ${healthCell(
    '元审计',
    row.auditAgree,
    row.auditable
  )} ${healthCell('高危已批准', row.highRiskApproved, row.highRisk)} 未覆盖意图 ${
    row.uncovered === 0
      ? statusChip('ok', '✓', '0')
      : statusChip('warn', '⚠', String(row.uncovered))
  }</li>`

const featureHealthSection = (snapshot: UiSnapshot): string => {
  const rows = featureHealthRows(snapshot)
  const body =
    rows.length === 0
      ? `<p>${statusChip('muted', '○', '暂无活跃条款', 'health-none')} — 先运行 <code>urtext index</code></p>`
      : `<ul>${rows.map(featureHealthRow).join('')}</ul>`
  return `<section id="feature-health" aria-labelledby="feature-health-title"><h2 id="feature-health-title">Feature health (${
    rows.length
  })</h2>${body}<p><small>只读投影：不进入队列、WIP 或退出码；点 feature 打开 All Specs。</small></p></section>`
}
```

挂载点（`renderConsoleFamilyPage` 的 `main` 拼装）：

```ts
const main = `<main id="main">${route === 'queue' ? summary(snapshot) : ''}${workspaceAlert(
  snapshot,
  route
)}${route === 'queue' ? featureHealthSection(snapshot) : ''}${route === 'queue' ? explainControls() : ''}${notice}${body}${paginationNav(
  ROUTE_PATH[route],
  w
)}${route === 'queue' ? uncoveredIntentSection(snapshot) : ''}</main>`
```

- **决策**：queue 路由独占，且排在 `workspaceAlert` **之后**、队列表之前。*被否决的备选*：排在 summary 与 alert 之间 —— 会把 `role="alert"` 的 unmapped 横幅推到一串 feature 行之下，违反 D2/D3（fail-closed 告警永远最靠前）；"Console page top" 的合同由"在队列表之上"满足。
- **决策**：四个路由不共享此区块。*被否决的备选*：四个路由都渲染 —— fixture 与 selector 矩阵直接翻四倍，而 `/specs` 本身就是它的下钻目标，重复渲染没有信息增量。

---

## 3. P3 一跳邻域：数据管道与渲染

### 3.1 数据缺口（F10）

`SpecImpactView` 既没有 `refs`（出边），`impact.affectedClauses` 又是**传递闭包**不是一跳。brief manifest 带 `refs: string[]`（`src/brief.ts:62,271-273`），一跳依赖需要一次窄查询 —— pinned #3 明确允许 "what the brief already carries or trivially can"。

```ts
interface DirectDependentRow {
  spec_path: string
  clause_id: string
}

/**
 * One-hop dependents: clauses whose live `refs:` edge points AT the target. The
 * brief already carries the full transitive closure, but a neighbourhood view
 * must not lie about distance. Narrow, id-scoped query — never a liveGraph
 * rebuild (round-2 MN-5).
 */
const directDependents = (db: Database, target: ClauseTarget): ClauseTarget[] =>
  (
    db
      .prepare(
        `SELECT e.spec_path, e.clause_id
         FROM clause_refs e
         JOIN (
           SELECT spec_path, MAX(revision) AS revision
           FROM revisions WHERE file_kind = 'clauses' GROUP BY spec_path
         ) latest ON latest.spec_path = e.spec_path AND latest.revision = e.revision
         JOIN revisions r ON r.spec_path = e.spec_path AND r.revision = e.revision
         WHERE e.to_spec = ? AND e.to_clause = ? AND r.status != 'tombstoned'
         ORDER BY e.spec_path, e.clause_id`
      )
      .all(target.specPath, target.clauseId) as DirectDependentRow[]
  ).map((row) => ({ specPath: row.spec_path, clauseId: row.clause_id }))
```

### 3.2 视图契约（`src/ui/contracts.ts`）

**决策**：复用既有 `ImpactDependent`，不新增邻居类型。
*被否决的备选*：新建 `NeighborClause`（带 `risk`）—— 与 `ImpactDependent` 五个字段里有五个重合，第二个近似类型只会招致漂移；风险等级点进目标页就能看到。

```ts
export interface SpecImpactView {
  // …既有字段…
  requirementBindings: RequirementBindingView[]
  /** Outgoing `refs:` targets in declaration order (brief manifest `refs`). */
  refs: ImpactDependent[]
  mappings: BriefMapping[]
  impact: Brief['impact']
  dependents: ImpactDependent[]
  /** Clauses whose `refs:` point AT this one — one hop, not the closure. */
  oneHopDependents: ImpactDependent[]
  navigation: ClauseNavigation
}
```

### 3.3 装配（`src/review-ui.ts`）

```ts
const splitClauseKey = (key: string): ClauseTarget => {
  const hash = key.lastIndexOf('#')
  return { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) }
}

// inside handleBrief, after `decisionByKey` (review-ui.ts:241-242):
const toNeighbor = (neighbor: ClauseTarget): ImpactDependent => {
  const decision = decisionByKey.get(`${neighbor.specPath}#${neighbor.clauseId}`)
  return {
    specPath: neighbor.specPath,
    clauseId: neighbor.clauseId,
    title: decision?.title ?? '',
    stale: decision?.stale ?? false,
    evidenceVerdict: decision?.evidenceVerdict ?? 'missing',
  }
}
const dependents: ImpactDependent[] = outcome.brief.impact.affectedClauses.map(toNeighbor)
const refs: ImpactDependent[] = manifest.refs.map(splitClauseKey).map(toNeighbor)
const oneHop: ImpactDependent[] = directDependents(db, target).map(toNeighbor)
```

`buildSpecImpactView` **追加两个可选位置参数**：

```ts
export const buildSpecImpactView = (
  brief: Brief,
  dependents: ImpactDependent[] = [],
  navigation: ClauseNavigation = { previous: null, next: null },
  requirementBindings: RequirementBindingView[] = [],
  refs: ImpactDependent[] = [],
  oneHopDependents: ImpactDependent[] = []
): SpecImpactView => ({ /* …字段按 interface 顺序… */ })
```

- **决策**：追加可选位参。*被否决的备选*：改成选项对象 —— `buildSpecImpactView` 在 `src/index.ts:117` 的公开导出面上，改签名是破坏性变更；而"依次追加可选参数"正是这个函数已经经历过三次的既定演化方式（dependents → navigation → requirementBindings）。丑，但不破坏公开面。

### 3.4 渲染（`src/ui/render-brief.ts`）

三列盒图，**不动**既有 `requirement-bindings` 区块（browser 矩阵断言其恰好 1 个，`scripts/ui-browser-check.ts:625`）：邻域的 FR 列只显示 key，不重复 title。

```ts
const neighborItem = (neighbor: ImpactDependent): string => {
  const state = neighbor.stale ? 'neighbor-stale' : 'neighbor-current'
  const label = neighbor.stale ? 'stale' : neighbor.evidenceVerdict
  return `<li data-state="${state}"><a href="${esc(
    briefHref(neighbor.specPath, neighbor.clauseId)
  )}">${esc(clauseKey(neighbor))}</a> ${esc(neighbor.title)} — ${esc(label)}</li>`
}

const neighborColumn = (slot: string, heading: string, items: string[], empty: string): string =>
  `<div data-neighbor="${esc(slot)}"><h3>${esc(heading)}</h3>${
    items.length === 0 ? `<p>${esc(empty)}</p>` : `<ul>${items.join('')}</ul>`
  }</div>`

/**
 * P3 one-hop neighbourhood: defended FRs ← this clause → its refs targets →
 * its direct dependents. Box drawing is plain flex + 1px borders on existing
 * tokens — no library, no dependency, no svg/canvas. The FR column has no empty
 * branch: C020 makes ≥1 binding mandatory for a `ready` revision, and buildBrief
 * refuses anything unresolved (round-2 ruling #7), so an unreachable state is
 * never rendered.
 */
const neighborhoodSection = (view: SpecImpactView): string => {
  const defended = view.requirementBindings
    .filter(
      (binding): binding is Extract<RequirementBindingView, { state: 'resolved' }> =>
        binding.state === 'resolved'
    )
    .map(
      (binding) =>
        `<li data-state="neighbor-req"><code>${esc(
          `${binding.target.specPath}#${binding.target.reqId}`
        )}</code></li>`
    )
  const self = `<div data-neighbor="self"><h3>本条</h3><p><code>${esc(
    clauseKey(view.target)
  )}</code> ${riskBadge(view.risk)}</p></div>`
  return `<section data-section="neighborhood" aria-labelledby="neighborhood-title"><h2 id="neighborhood-title">One-hop neighbourhood / 一跳邻域</h2><div data-neighborhood>${neighborColumn(
    'reqs',
    '守护的意图 →',
    defended,
    '（无）'
  )}${self}${neighborColumn(
    'refs',
    '→ 本条依赖',
    view.refs.map(neighborItem),
    '本条不依赖任何子句'
  )}${neighborColumn(
    'dependents',
    '→ 直接依赖本条',
    view.oneHopDependents.map(neighborItem),
    '无直接依赖方'
  )}</div><p><small>只显示一跳；完整传递闭包见下方 Stale Dependencies（${
    view.dependents.length
  } 条）。</small></p></section>`
}
```

插入位置：`renderBriefPage` 的 `main` 中，`resolvedRequirementBindingsHtml` 之后、`mappings` 之前 —— 先给全局位置感，再看局部细节（D3 orient → blocker → evidence）。

CSS（`src/ui/theme.ts`，插在 `pre{overflow-x:auto;white-space:pre}` 之后、`@media` 块之前）：

```css
[data-neighborhood]{display:flex;flex-wrap:wrap;gap:var(--sp-3)}
[data-neighbor]{flex:1 1 14rem;border:1px solid var(--border);padding:var(--sp-3)}
[data-neighbor] h3{margin:0 0 var(--sp-2)}
```

- **决策**：只用 `--border` 与间距 token，不引入任何新颜色。*被否决的备选*：给三列各配 tone 底色 —— 会产生新的 fg/bg 文本对，必须进 `REGISTERED_PAIRS` 并补 consumer；而三列本身没有状态语义，颜色会谎报"这一列有问题"。
- `flex:1 1 14rem`（html 基准 14px ⇒ 196px）在 390px viewport 上自然折行，满足 `no-horizontal-overflow` 断言；不触碰 `ui-html.test.ts:207-224` 的四条 THEME_CSS 正则（无 `url(` / `@import` / `http`）。

---

## 4. P4 AI explain 泛化

### 4.1 新 prompt 全文（per-clause）

```ts
/**
 * Adjudication-oriented explanation of ONE clause. Facts come from the brief
 * manifest only (traceable); the answer is prose for a human and NEVER enters
 * the registry (R4 red line — see operator-flow plan :183).
 */
const CLAUSE_EXPLAIN_PROMPT = [
  '你是 Urtext 的裁决助手。下面是一条子句的完整裁决简报（条文、需求绑定、映射代码、证据、影响闭包、历史）。',
  '请只依据简报里的事实，用中文写三段，每段以给定小标题开头；不要输出其他章节，不要整段复述简报。',
  '',
  '## 为什么需要你',
  '说明这条子句为什么停在人工裁决上：在它当前的证据 verdict、元审计状态、风险等级、stale 标记里，',
  '具体是哪一项使机器无法自动放行。引用简报中的真实字段值，不要写"因为需要人工确认"这类同义反复。',
  '',
  '## 批准与拒绝分别意味着什么',
  '分别说明两个方向的实际后果：批准会解开哪些下游条款与任务（用简报 impact 段里的真实 key），',
  '拒绝会挡住什么、以及在什么条件下应当拒绝。各给一个基于本条映射代码的具体场景，不要通用流程描述。',
  '',
  '## 哪里有风险信号',
  '列出简报中值得警惕的信号：映射 diff 的改动面、下游已 stale 的条款、证据输出里的异常行、',
  '需求绑定与条文语义是否一致。如果确实没有可疑信号，就写"未发现风险信号"，不要编造。',
  '',
  '硬性约束：只解释，不给出批准/拒绝的结论或倾向；不要建议或执行任何命令；不要修改任何文件；',
  '不要引入简报之外的事实。你的输出只会显示给人看，不会写入任何账本。',
  '',
].join('\n')
```

- **决策**：删掉旧 prompt 的"一句话给出你的倾向"（`src/review-ui.ts:358`）。*被否决的备选*：保留倾向输出 —— 在批准按钮旁边给出 AI 结论，正是本仓库用"批准必须手写一句理由"（`src/review-ui.ts:307-308`）明确防的橡皮图章；解释后果可以，替人裁决不行。
- prompt 与简报之间不加分隔符，直接 `CLAUSE_EXPLAIN_PROMPT + renderBriefText(...)`（模板末尾已有空行）。

### 4.2 queue-scope prompt 与容量上限

```ts
const QUEUE_EXPLAIN_MAX_ITEMS_ENV = 'URTEXT_EXPLAIN_QUEUE_MAX_ITEMS'

/** A queue is unbounded (one item per unadjudicated clause plus one per unmapped
 * hunk); the prompt is not. `omp` additionally takes the prompt as an argv arg
 * (audit-runner.ts:255), so an uncapped queue would eventually hit ARG_MAX.
 * Same env-with-default shape as `auditTimeoutMs` (audit-runner.ts:18-22). */
const queueExplainMaxItems = (): number => {
  const raw = process.env[QUEUE_EXPLAIN_MAX_ITEMS_ENV]
  const parsed = raw ? Number(raw) : NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 40
}

const queueItemLine = (item: StatusItem): string =>
  `  - ${item.key}${item.risk === 'high' ? ' [high]' : ''} — ${item.primary}${
    item.reasons.length > 1 ? ` (+${item.reasons.slice(1).join(', ')})` : ''
  }${item.invalidationSource !== undefined ? ` [证据被 ${item.invalidationSource} 作废]` : ''}`

const queueLaneBlock = (label: string, items: StatusItem[], maxItems: number): string[] => {
  const shown = items.slice(0, maxItems)
  const suffix = items.length > shown.length ? `，以下只列前 ${shown.length} 条` : ''
  return [
    `${label}（共 ${items.length} 条${suffix}）：`,
    ...(shown.length === 0 ? ['  （空）'] : shown.map(queueItemLine)),
  ]
}

/** Queue-scope explanation, built from the SAME snapshot the console renders. */
const queueExplainPrompt = (snapshot: UiSnapshot, maxItems: number): string => {
  const human = snapshot.status.items.filter((item) => item.lane === 'human')
  const agent = snapshot.status.items.filter((item) => item.lane === 'agent')
  const uncovered = snapshot.status.uncoveredRequirements
  return [
    '你是 Urtext 的裁决助手。下面是当前工作区的裁决队列快照（与 `urtext status` 同一个构建器产出）。',
    '请只依据这份快照，用中文写三段，每段以给定小标题开头；不要输出其他章节。',
    '',
    '## 为什么需要你',
    '概括这条队列此刻卡在人这里的根因结构：哪几类 reason code 占主导，它们是同一个上游变更的连锁反应还是彼此独立。',
    '',
    '## 批准与推进分别意味着什么',
    '给出最多三步的处理顺序，每步指明具体 item key 与理由，并说明做完之后队列会怎样收缩。',
    '优先级只能基于快照事实：unmapped 直接阻断合入、high 风险不可自动放行、stale 的上游来源可能一次解开多条。',
    '',
    '## 哪里有风险信号',
    '指出快照里值得警惕的地方：WIP 超限、未覆盖意图、unmapped 检测失败、同一个上游造成的大面积 stale。',
    '没有就写"未发现风险信号"，不要编造。',
    '',
    '硬性约束：只解释，不要替人做批准/拒绝决定；不要修改任何文件；不要引入快照之外的事实。',
    '你的输出只会显示给人看，不会写入任何账本。',
    '',
    `HEAD: ${snapshot.head?.slice(0, 7) ?? 'n/a'}${snapshot.dirty ? '（工作树有未提交改动）' : ''}`,
    `计数: 人 ${snapshot.status.counts.human} / agent ${snapshot.status.counts.agent} / 自动通过 ${snapshot.status.counts.autoPass} / 未覆盖意图 ${snapshot.status.counts.uncovered}`,
    `WIP: 上限 ${snapshot.status.wip.limit}${snapshot.status.wip.exceeded ? '（已超限）' : ''}`,
    snapshot.unmappedError !== null
      ? `unmapped 检测失败: ${snapshot.unmappedError}（不能证明不存在未归属变更）`
      : `未归属变更: ${snapshot.unmapped.length} 处`,
    '',
    ...queueLaneBlock('人车道', human, maxItems),
    '',
    ...queueLaneBlock('agent 车道', agent, maxItems),
    '',
    `未覆盖意图（${uncovered.length}）：`,
    ...(uncovered.length === 0
      ? ['  （空）']
      : uncovered
          .slice(0, maxItems)
          .map((requirement) => `  - ${requirement.specPath}#${requirement.reqId} ${requirement.title}`)),
  ].join('\n')
}
```

P1 的产出在这里被复用：`[证据被 X 作废]` 让模型能看见"一次上游变更炸掉一片"的结构 —— 这正是 queue 摘要最有价值的判断。

### 4.3 API 形状与校验

**决策**：复用 `/api/explain`，用可选 `scope` 判别式扩展，不新增端点。
*被否决的备选*：新增 `/api/explain-queue` —— 需要新的 `PathClass`、新的 acceptance ledger 分类、新的 Host/Origin/CSRF 矩阵行；而 pinned #4 要求"除非证明重载更糟"，此处重载只多一个分支，且两种 scope 的安全前置、fail-closed 语义、read-only 语义完全相同。

```ts
type ExplainScope = 'clause' | 'queue'

const parseExplainScope = (value: unknown): ExplainScope | null =>
  value === undefined || value === 'clause' ? 'clause' : value === 'queue' ? 'queue' : null

/**
 * On-demand explanation. Two scopes over ONE endpoint:
 *   { key, auditor, model? }                — this clause, from its own brief
 *   { scope: 'queue', auditor, model? }     — the whole queue, from buildUiSnapshot
 * Read-only in both: no ledger write, no tools, narrative never enters the
 * registry (R4). Absent `scope` keeps the original clause contract byte-for-byte,
 * including its 400 message.
 */
export const handleExplain = async (
  db: Database,
  root: string,
  input: unknown,
  deps: AgentTransportDeps = {}
): Promise<ExplainApiResult> => {
  if (typeof input !== 'object' || input === null) return { status: 400, body: { error: 'bad request' } }
  const scope = parseExplainScope('scope' in input ? input.scope : undefined)
  const auditor = parseAuditorId('auditor' in input ? input.auditor : undefined)
  const model = 'model' in input ? input.model : undefined
  if (scope === null) return { status: 400, body: { error: 'scope must be clause|queue' } }
  if (model !== undefined && typeof model !== 'string')
    return { status: 400, body: { error: 'model must be a string' } }

  let prompt: string
  if (scope === 'queue') {
    if (auditor === null)
      return { status: 400, body: { error: 'need { scope: queue, auditor: claude|codex|traex|omp }' } }
    prompt = queueExplainPrompt(buildUiSnapshot(db, root), queueExplainMaxItems())
  } else {
    const key = 'key' in input ? input.key : undefined
    if (typeof key !== 'string' || key.lastIndexOf('#') <= 0 || auditor === null)
      return { status: 400, body: { error: 'need { key, auditor: claude|codex|traex|omp }' } }
    const hash = key.lastIndexOf('#')
    const target = { specPath: key.slice(0, hash), clauseId: key.slice(hash + 1) }
    const outcome = buildBrief(db, root, target)
    if (outcome.kind === 'refused') return { status: 409, body: { error: outcome.message } }
    prompt = `${CLAUSE_EXPLAIN_PROMPT}${renderBriefText(outcome.brief, briefHistory(db, target))}`
  }

  const result = await runAgentText(
    prompt,
    { id: auditor, ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}) },
    deps.spawnAsync
  )
  return result.kind === 'completed' && result.text !== undefined
    ? { status: 200, body: { ok: true, text: result.text } }
    : { status: 422, body: { error: result.message ?? 'agent failed' } }
}
```

三条既有 400 测试（`tests/review-ui.test.ts:388-393`）逐条仍然命中：缺 auditor → clause 分支 400；`key:'nohash'` → 400；`auditor:'bogus'` → `parseAuditorId` 返回 null → 400。

### 4.4 安全链证明（逐级，全部复用，无新代码路径）

| 级 | 机制 | 位置 | queue-scope 是否复用 |
|---|---|---|---|
| 1 | 路由分类 `POST /api/explain → 'explain'` | `src/ui-server.ts:101` | 是（同一路径，未新增 PathClass） |
| 2 | Host 白名单，403 且**先于任何 dispatch** | `:314-321`（测试 `tests/ui-server.test.ts:298`） | 是 |
| 3 | 同源 Origin，hostile → 403 | `:322-329` | 是 |
| 4 | 每会话 CSRF header 全等 | `:247-250` | 是 |
| 5 | 精确 `application/json`（含重复头检测）→ 415 | `:116-136,251-254` | 是 |
| 6 | 4096 字节真实字节上限 → 413 | `:41,142-152,255-259` | 是；`{"scope":"queue","auditor":"omp","model":"…"}` < 100B |
| 7 | `JSON.parse` 失败 → 400 | `:260-266` | 是 |
| 8 | handler 内校验 → 400 | 本节 §4.3 | 是（scope/auditor/model/key 全覆盖） |
| 9 | agent 传输 fail-closed（缺客户端/非零退出/超时/空输出 → rejected）→ 422 | `src/audit-runner.ts:261-286` | 是（同一 `runAgentText`） |
| 10 | 脱敏请求账本：只记 `{method,pathClass,status,stage,hostClass,originClass}` | `src/ui-server.ts:57-64,302-304` | 是（形状不变，queue 调用只多一条同形记录） |

新增的 `buildUiSnapshot` 调用发生在 handler 内、`scanWorkspace` 之后（`src/ui-server.ts:278`），只读；prompt 不落盘、不进任何账本。

### 4.5 控件泛化：标记与脚本

**brief 页**：把 explain 从 `reviewSection` 中拆出，改为**每个成功 brief 页**都渲染；`reviewSection` 只留审查表单。

```ts
const explainSection = (input: BriefPageInput): string =>
  `<section id="explain" aria-labelledby="explain-title" data-explain-key="${esc(input.key)}">
<h2 id="explain-title">AI 解释</h2>
<label for="explain-auditor">审查客户端</label>
<select id="explain-auditor"><option value="omp" selected>OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option></select>
<label for="explain-model">模型</label>
<input id="explain-model" value="deepseek/deepseek-v4-flash">
<button type="button" id="explain-btn">AI 解释这条</button>
<output id="explain-out" aria-live="polite"></output>
<p><small>只读：不写任何账本，说明不会进入注册表。</small></p>
</section>`
```

`renderBriefPage` 相应改动：`main` 中 `${explainSection(input)}${input.reviewable ? reviewSection(input) : ''}`；脚本改为**无条件注入** `<script>${BRIEF_SCRIPT}</script>`（错误页仍然没有脚本）。`BRIEF_SCRIPT` 的 explain 块把 `&& form` 依赖去掉，key 改从容器的 `data-explain-key` 读：

```js
const explainBtn = document.getElementById('explain-btn')
const explainHost = document.querySelector('[data-explain-key]')
if (explainBtn && explainHost) {
  const explainAuditor = document.getElementById('explain-auditor')
  const explainModel = document.getElementById('explain-model')
  const explainOut = document.getElementById('explain-out')
  const defaultModel = { omp: 'deepseek/deepseek-v4-flash', claude: 'sonnet', codex: 'gpt-5.6-terra', traex: 'kimi-k2.6' }
  explainAuditor.addEventListener('change', () => { explainModel.value = defaultModel[explainAuditor.value] })
  explainBtn.addEventListener('click', async () => {
    explainBtn.disabled = true
    explainOut.textContent = '正在生成解释，可能需要一会儿…'
    try {
      const r = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf': csrf },
        body: JSON.stringify({ key: explainHost.dataset.explainKey, auditor: explainAuditor.value, model: explainModel.value }),
      })
      const j = await r.json()
      explainOut.textContent = j.error ? j.error : j.text
    } catch { explainOut.textContent = '生成失败，请重试或换一个客户端。' }
    explainBtn.disabled = false
  })
}
```

**console 页**：一个共享客户端选择器 + queue 摘要按钮 + 每个 human-lane clause 行一个按钮。

```ts
/** Shared client picker + queue-scope summary. Static ids stay unique per page:
 * `#explain-btn` remains brief-only (browser matrix asserts count 0 on console,
 * ui-browser-check.ts:603). */
const explainControls = (): string =>
  `<section id="queue-explain" aria-labelledby="queue-explain-title">
<h2 id="queue-explain-title">AI 解释</h2>
<label for="queue-explain-auditor">客户端</label>
<select id="queue-explain-auditor"><option value="omp" selected>OMP</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="traex">Traex</option></select>
<label for="queue-explain-model">模型</label>
<input id="queue-explain-model" value="deepseek/deepseek-v4-flash">
<button type="button" id="queue-explain-btn">AI 总结当前队列</button>
<output id="queue-explain-out" aria-live="polite"></output>
<p><small>只读：解释不写任何账本；每条待办右侧也有单条解释按钮。</small></p>
</section>`
```

`queueRow` 增一个显式的 `lane` 开关（不再用 `decideForm` 隐式代表"queue 路由"），clause 行追加：

```ts
// clause branch of queueRow, only on the human lane (an unmapped hunk has no
// clause key and therefore no brief to explain).
const explain = explainForItem
  ? ` <button type="button" id="explain-item-btn-${index}" data-explain-key="${esc(
      key
    )}">AI 解释</button> <output id="explain-item-out-${index}" aria-live="polite"></output>`
  : ''
```

CONSOLE_SCRIPT 追加（沿用既有委托监听风格，无内联 handler、无 `prompt()`/`alert()`）：

```js
const explainPicker = () => {
  const auditor = document.getElementById('queue-explain-auditor')
  const model = document.getElementById('queue-explain-model')
  return { auditor: auditor ? auditor.value : 'omp', model: model ? model.value : '' }
}
const runExplain = async (button, output, body) => {
  button.disabled = true
  output.textContent = '正在生成解释，可能需要一会儿…'
  try {
    const r = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf': csrf },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    output.textContent = j.error ? j.error : j.text
  } catch { output.textContent = '生成失败，请重试或换一个客户端。' }
  button.disabled = false
}
document.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('[data-explain-key]') : null
  if (!button) return
  const output = document.getElementById(button.id.replace('-btn-', '-out-'))
  if (!output) return
  const picker = explainPicker()
  void runExplain(button, output, { key: button.dataset.explainKey, auditor: picker.auditor, model: picker.model })
})
document.getElementById('queue-explain-btn')?.addEventListener('click', (e) => {
  const output = document.getElementById('queue-explain-out')
  const picker = explainPicker()
  void runExplain(e.currentTarget, output, { scope: 'queue', auditor: picker.auditor, model: picker.model })
})
```

- **决策**：`type="button"` + click 委托，不用 `<form>`。*被否决的备选*：仿 `#audit-runner` 用表单提交 —— explain 不写任何东西，没有提交语义；brief 页的 `#explain-btn` 已经是 button+click 的既定范式。
- **决策**：一个共享 picker，不是每行一份。*被否决的备选*：每行 select+input —— 队列有 100 行时就是 100 个重复表单控件，AX 树和 tab 序都会被淹没。
- **决策**：每个新按钮/输出都有唯一静态或动态 id（`queue-explain-btn`、`explain-item-btn-{index}`）。*被否决的备选*：无 id 的按钮 —— `captureFocusOrder` 用 `id || tagName` 做身份（F16），无 id 的同类控件会被 `validateFocusOrder` 判成 duplicate focus stop，直接把浏览器门打红。

**静态 ID 注册增补**（§6.4 冻结表新增）：`feature-health｜feature-health-title｜queue-explain｜queue-explain-title｜queue-explain-auditor｜queue-explain-model｜queue-explain-btn｜queue-explain-out｜explain｜explain-title｜neighborhood-title`。
**动态 ID pattern 增补**：`explain-item-btn-{index}｜explain-item-out-{index}`（index 取稳定渲染数组位置，与 `decision-form-{index}` 同规则）。

---

## 5. P5 批准语义静态文案

纯文案 + 渲染，两处，各自读**已经在手边**的 HEAD。

brief 页（`reviewSection` 内，提交按钮之前）：

```ts
const approveSemantics = (head: string | null): string =>
  `<p id="approve-semantics">本次判定绑定 HEAD <code>${esc(
    head?.slice(0, 7) ?? 'n/a'
  )}</code>：代码再动自动失效，需重审；工作树必须干净，批准必须写一句理由。</p>`
```

console 队列的 decide 表单内同样插入一份（id 用 `approve-semantics-${index}` 以保持页内唯一）。`queueRow` 因此需要 `head`，从 `renderConsoleFamilyPage` 一路透传（`queueSection(items, w, snapshot.head)` → `queueRow(item, {decideForm, explainForItem, head}, index)`）。

- **决策**：文案在渲染层写死，不做 i18n。*被否决的备选*：抽 copy 表/多语言 —— 整个 UI 层全部中文硬编码（`render-console.ts`、`render-brief.ts` 每一行），单独给这一句引入间接层是凭空多一个抽象。
- **决策**：不用 `data-tone` 着色。*被否决的备选*：`warn` tone —— 这是规则说明不是告警，染成警告色会让 D4 的三通道语义贬值（"到处都是黄色 = 没有黄色"）。
- HEAD 为 null 时渲染 `n/a`，与 `header()`（`render-console.ts:40`）、`oracleMeta()`（`render-brief.ts:19`）的既有降级一致；不为此单独登记可见分支，因为既有实现同样没有登记（保持枚举粒度一致）。

---

## 6. Contrast manifest：分支、fixture、再生成

### 6.1 哈希影响面

本轮触碰 `src/ui/theme.ts`、`html.ts`（不变）、`contracts.ts`、`render-console.ts`、`render-brief.ts`、`console-script.ts`、`brief-script.ts` —— 8 文件源哈希表中的 6 个变动 ⇒ `sourceContractSha256` 必变；每个 fixture 的渲染输出变动 ⇒ `renderContractSha256` 必变。两套实现（`tests/ui-component-contrast.test.ts:83-92` 与 `scripts/ui-browser-check.ts:112-121`）的文件清单本轮**不变**（round-2 已补齐 `contracts.ts`），无需再同步。

### 6.2 新增 canonical branches（恰好 13，46 → 59）

| branch id | 含义 | 覆盖 fixture |
|---|---|---|
| `console.featureHealth.rows` | 至少一个 feature 行 | `console-busy`（补 `clauses`） |
| `console.featureHealth.empty` | 零活跃子句空态 | `console-quiet` |
| `console.causal.sourced` | stale 行带 `invalidation_source` | `agent-stale`（新） |
| `console.causal.legacy` | stale 行无来源（历史 NULL） | `agent-stale`（新） |
| `console.explain.item` | 人车道条款行的单条解释按钮 | `console-busy` |
| `console.explain.queue` | 队列摘要控件 | `console-quiet` |
| `console.approveCopy` | decide 表单内的绑定说明 | `console-busy` |
| `brief.neighborhood.refs` | 出边列非空 | `brief-full` |
| `brief.neighborhood.refsEmpty` | 出边列空态 | `brief-quiet` |
| `brief.neighborhood.dependents` | 一跳依赖列非空 | `brief-stale` |
| `brief.neighborhood.dependentsEmpty` | 一跳依赖列空态 | `brief-quiet` |
| `brief.explain.control` | 解释控件（含 `reviewable=false` 页） | `brief-quiet` |
| `brief.approveCopy` | 审查表单内的绑定说明 | `brief-full` |

不登记的分支及理由：邻域 FR 列没有空态（C020 + buildBrief 拒绝，round-2 ruling #7 同款）；HEAD 为 null 的降级（既有实现同样未登记，粒度一致）；unmapped 行没有解释按钮（是"不渲染"，不是新可见分支）。

### 6.3 fixtureMatrix 逐条改动

> 纪律（round-2 实证）：哈希对 JSON 缩进不敏感但 **key 顺序 load-bearing**（`JSON.parse` 保序）。所有新字段必须**原位插入**到语义相邻的位置，禁止整体 re-serialize。

| fixture | 改动 | 新 branch |
|---|---|---|
| `console-quiet` | 无（`clauses: []` 已经就是空态） | `console.featureHealth.empty`、`console.explain.queue` |
| `console-busy` | `snapshot.clauses` 从 `[]` 改为 3 条（`specs/a` 两条含一条 high+`reviewStatus:'approved'`，`specs/b` 一条），每条补 `auditVerdict`/`reviewStatus` | `console.featureHealth.rows`、`console.explain.item`、`console.approveCopy` |
| `console-unmapped-error` | 无 | — |
| `agent-busy` / `agent-zero` | 无 | — |
| **`agent-stale`（新）** | route `agent`、page 1、pageSize 20、两条 stale item：`specs/a/spec.md#C004`（`invalidationSource:'specs/a/spec.md#FR001'`）与 `specs/a/spec.md#C005`（无该字段） | `console.route.agent`、`console.pagination.single`、`console.auditRunner.disabled`、`console.audit.absent`、`console.causal.sourced`、`console.causal.legacy` |
| `specs-groups` / `specs-empty` / `decisions-rows` / `decisions-empty` | 每条 `clauses[]` 元素补 `auditVerdict`/`reviewStatus`（`UiClause` 新增必填字段） | — |
| `brief-full` | `view.refs`: 1 条；`view.oneHopDependents`: 1 条 | `brief.neighborhood.refs`、`brief.neighborhood.dependents`(见下)、`brief.explain.control`、`brief.approveCopy` |
| `brief-quiet` | `view.refs: []`；`view.oneHopDependents: []` | `brief.neighborhood.refsEmpty`、`brief.neighborhood.dependentsEmpty`、`brief.explain.control` |
| `brief-stale` | `view.refs: []`；`view.oneHopDependents`: 1 条 stale | `brief.neighborhood.dependents` |
| `brief-truncated` | `view.refs: []`；`view.oneHopDependents: []` | — |
| `error-page` / `error-broken-requirements` | 不动（`renderBriefErrorPage` 未改） | — |

`consumers` 数组 **32 条一条不动**：新标记只复用 `a`、`table`/`table a`、`[data-tone="muted"|"ok"|"warn"|"danger"]`、`button[disabled]` 这些每页均已登记的选择器，不引入新的 fg/bg 对，也不引入新的 focus-visible 元素。`agent-stale` 是 `page: 'console'` 的新 fixture，`real → manifest` 是按**页**聚合的（`tests/ui-component-contrast.test.ts:381-389`），故不产生新 consumer 需求。

### 6.4 再生成程序（既定，不新增 writer）

沿用 round-2 裁决 #12 的唯一合法路径：编译 `$ACC` → 调用已导出的 `verifyContrastManifest` 取 actuals → 锚定正则原位替换两个 64-hex 字段 → 两套 verifier 复核。

```sh
# 0. 从仓库根执行；先改完代码与 fixture，两个 sha 字段保持旧值不动（禁止手敲）。

# 1. 外置 outDir 编译（scripts/ui-acceptance.md §1 的既有命令 + compileAccBuild 的两处装饰）
ACC=$(mktemp -d /tmp/urtext-acc-XXXXXX)
node_modules/.bin/tsc -p scripts/tsconfig.ui-acceptance.json --outDir "$ACC"
printf '{"type":"module"}\n' > "$ACC/package.json"          # 否则 Node 按 CJS 解析 ESM 语法报错
ln -s "$PWD/node_modules" "$ACC/node_modules"                # better-sqlite3 等运行期依赖
test -f "$ACC/scripts/ui-browser-check.js"

# 2. 用仓库自己的第二套实现重算，机械回写恰好两行
ACC="$ACC" node --input-type=module -e '
  const { readFileSync, writeFileSync } = await import("node:fs")
  const { verifyContrastManifest } = await import(process.env.ACC + "/scripts/ui-browser-check.js")
  const path = "tests/ui-contrast-manifest.json"
  const actual = Object.fromEntries(
    verifyContrastManifest(path, ".").assertions.map((a) => [a.name, a.actual])
  )
  const source = actual["contrast-manifest:source-contract-sha256"]
  const render = actual["contrast-manifest:render-contract-sha256"]
  const before = readFileSync(path, "utf8")
  const after = before
    .replace(/("sourceContractSha256": ")[0-9a-f]{64}"/, `$1${source}"`)
    .replace(/("renderContractSha256": ")[0-9a-f]{64}"/, `$1${render}"`)
  if (after === before) throw new Error("no hash field was rewritten — check the manifest formatting")
  writeFileSync(path, after)
'

# 3. 两个独立门都必须绿（互为交叉校验）
node_modules/.bin/vitest run tests/ui-component-contrast.test.ts
ACC="$ACC" node --input-type=module -e '
  const { verifyContrastManifest } = await import(process.env.ACC + "/scripts/ui-browser-check.js")
  const v = verifyContrastManifest("tests/ui-contrast-manifest.json", ".")
  if (!v.assertions.every((a) => a.pass)) { console.error(v.assertions); process.exit(1) }
'

# 4. 清理并证明 acceptance build 没落进仓库
rm -rf "$ACC"
test ! -e dist/scripts && test ! -e scripts/ui-browser-check.js
git status --porcelain    # 只应出现本次有意修改的文件
```

- **决策**：不提交 hash writer。*被否决的备选*：新增 `scripts/ui-contrast-manifest.ts` writer —— round-2 已裁决（MJ-5）：新 writer 本身是需要独立测试的新代码，而两套既有 verifier 已经能提供 actuals；多一个可写 hash 的入口就多一条绕过审查的路。
- 顺序不可换：先改 fixture 再重算；先跑 vitest 门再跑 browser 侧重算（两者文件清单若不同步会分叉出两个不同 digest，只可能一个通过）。

---

## 7. 测试计划

### 7.1 C027 的独立 oracle 文件：`tests/ui-projection.test.ts`

MN-6 前例：高危子句永不共享 oracle 文件（否则 C027 的断言一坏，会把已裁决的 C019/C026 重新拉回人工队列）。文件覆盖五个投影的**语义**，不是标记快照：

```ts
describe('P1 invalidation stamp', () => {
  test('propagateStale writes when + source in one mutation, attributing to the true origin', () => {
    // specs/a#C001 ← refs ← specs/b#C001 ← refs ← specs/c#C001
    // 改 a#C001 文本 → b/c 两条 evidence 的 invalidation_source 都是 'specs/a/spec.md#C001'
  })
  test('a requirement change attributes its direct hits to the FR, not to themselves', () => {
    // 改 FR001 → 绑定它的 C001 source = 'specs/x/spec.md#FR001'
    // 而 C001 的下游 C002 source 同样是该 FR（origin 沿闭包继承，不是上一跳）
  })
  test('a clause that is both text-changed and FR-hit is stamped with the FR, and its downstream with itself', () => {
    // round-1 final #9 的双变场景，锁死两条规则的组合
  })
  test('a legacy row (source NULL) stays NULL and never gains a fabricated culprit', () => {
    // 直接 UPDATE 造一条 invalidated_at 非空 / invalidation_source NULL 的行，再跑一次 propagateStale
    // WHERE invalidated_at IS NULL 保证不被改写
  })
  test('ensureEvidenceLedger migrates a source-less ledger additively', () => {
    // 手工建一张不含该列的 evidence 表 → ensureEvidenceLedger → 列存在、旧行值为 null
  })
})

describe('P1 causal sentence', () => {
  test('a stale agent-lane row renders culprit → self → gate consequence', () => {})
  test('a stale row without a source renders 上游变更, never a fake key', () => {})
  test('a non-stale row renders no data-causal element', () => {})
  test('a hostile source key is escaped', () => {}) // <script> 注入
})

describe('P2 feature health', () => {
  test('evidence uses pass/(pass+fail); pending and missing leave the denominator', () => {})
  test('audit agreement counts only runnable clauses (decisionVerdict === "n/a")', () => {})
  test('high-risk approved counts only reviewStatus === "approved"', () => {})
  test('a feature with uncovered intent and zero clauses still gets a row', () => {})
  test('a zero denominator renders 不适用, never ✓', () => {})
  test('the section is queue-only and adds no second list table', () => {})
})

describe('P3 neighbourhood', () => {
  test('refs column comes from the manifest refs in declaration order', () => {})
  test('dependents column is one hop only — a two-hop dependent appears in impact but not here', () => {})
  test('an isolated clause renders both empty states and still renders the FR column', () => {})
})

describe('P4 explain generalisation', () => {
  test('queue scope builds a prompt from the snapshot and never touches a ledger', () => {})
  test('queue scope caps items and says so in the prompt', () => {})
  test('scope: bogus is rejected 400 before any client is invoked', () => {})
  test('the clause prompt carries the three section headings and the no-verdict constraint', () => {})
  test('a non-reviewable brief page still renders the explain control', () => {})
  test('an unmapped queue row has no explain button (no clause key, no brief)', () => {})
})

describe('P5 approve semantics', () => {
  test('the brief copy names the bound HEAD short sha and the invalidation rule', () => {})
  test('the console copy renders inside the decide form only', () => {})
})
```

关键手法：注入 `spawnAsync` 桩（`tests/review-ui.test.ts` 已有范式）证明 prompt 内容与"零账本写入"；`decisions`/`reviews`/`audit_verdicts` 三张表在 explain 前后逐行相等，是 R4 红线的机械证明。

### 7.2 既有测试逐个盘点（会红的与要改的）

| 文件 | 影响 | 处理 |
|---|---|---|
| `tests/linker.test.ts` | `propagateStale` 数组断言不变；新增来源断言 | 加断言，不改既有 |
| `tests/status.test.ts` | items 用 `toMatchObject`、counts/wip 用 `toEqual` → 全绿 | 加一条 `invalidationSource` 断言 |
| `tests/gate.test.ts` | `ClauseDecision` 加必填字段；若有 `toEqual(decision)` 需补字段 | 按面补 |
| `tests/verifier.test.ts` | schema/迁移 | 加 additive 迁移断言 |
| `tests/brief.test.ts` | `BriefManifest` **未改** | 不动 |
| `tests/review-ui.test.ts` | `UiClause` 加两字段；explain 400 三例仍绿；`:361-367` 仍绿 | 补 `auditVerdict`/`reviewStatus` 断言 |
| `tests/ui-console.test.ts` | `:202` 单 table 不变（新区块是 `<ul>`）；`:129-175` 路由归属需补 `#feature-health`/`#queue-explain` 的 present/absent；`:191-197` id 唯一性覆盖新 id | 按面更新 |
| `tests/ui-brief.test.ts` | `:279-284`（reviewable=false 无 explain、无 script）**必红** —— 正是本轮要改的行为 | 反转为"非 reviewable 也有 explain 控件与脚本，但没有 review-form" |
| `tests/ui-req-observability.test.ts` | `UiSnapshot` 造型函数需补 `clauses` 新字段 | 补字段 |
| `tests/ui-server.test.ts` | Host 矩阵含 `/api/explain` → 不变；新增 queue-scope 的 400/403/415/413 行 | 加断言 |
| `tests/ui-html.test.ts` | THEME_CSS 四条正则不受新规则影响 | 不动 |
| `tests/ui-component-contrast.test.ts` | `CANONICAL_BRANCHES` +13 | 按 §6.2 更新 |
| `tests/ui-browser-check.test.ts` | `PAGE_SPECIFIC_SELECTORS` 变更 → 相关断言（`:706-744`）需同步 | 按 §7.3 更新 |
| `tests/ui-acceptance-fixture.test.ts` | `FIXTURE_TARGETS` 增 `stale` 键 → `:54-60` 的 `toEqual` **必红** | 补键 + 新增"C002 stale 且 source 为 C001"的断言 |
| `tests/ui-acceptance-server.test.ts` | 请求账本条数随新增 queue-scope 调用变化 | 新增一次 `{scope:'queue'}` 真 HTTP 调用并更新计数 |
| `tests/package-surface.test.ts` | 无新导出（F19） | 不动 |
| `tests/ui-pagination.test.ts`、`ui-evidence-manifest.test.ts`、`ui-browser-check-wrapper.test.ts` | 无关 | 不动 |

### 7.3 Browser acceptance（仍是 7 页，不加第八页）

`PAGE_SPECIFIC_SELECTORS` 增补（exact counts，基于 acceptance fixture 的真实投影：clean worktree、human 车道 = `[C004 high review_needed, C003 manual_undecided]`，pageSize 2 全在第 1 页）：

```ts
{ page: 'console', selector: '#feature-health', expectedCount: 1 },
{ page: 'console', selector: 'li[data-feature="demo"]', expectedCount: 1 },
{ page: 'console', selector: '#queue-explain-btn', expectedCount: 1 },
{ page: 'console', selector: 'button[data-explain-key]', expectedCount: 2 },
{ page: 'console', selector: '#approve-semantics-1', expectedCount: 1 },
{ page: 'console', selector: '[data-causal]', expectedCount: 0 },
{ page: 'agent', selector: '#feature-health', expectedCount: 0 },
{ page: 'agent', selector: '#queue-explain-btn', expectedCount: 0 },
{ page: 'agent', selector: 'button[data-explain-key]', expectedCount: 0 },
{ page: 'agent', selector: '[data-causal]', expectedCount: 1 },
{ page: 'specs', selector: '#feature-health', expectedCount: 0 },
{ page: 'specs-page-2', selector: '#feature-health', expectedCount: 0 },
{ page: 'decisions', selector: '#feature-health', expectedCount: 0 },
{ page: 'brief', selector: '[data-section="neighborhood"]', expectedCount: 1 },
{ page: 'brief', selector: '#approve-semantics', expectedCount: 1 },
{ page: 'brief', selector: '#queue-explain-btn', expectedCount: 0 },
{ page: 'error', selector: '[data-section="neighborhood"]', expectedCount: 0 },
{ page: 'error', selector: '#approve-semantics', expectedCount: 0 },
```

`PAGE_AX_LINK_SELECTORS` 增补：`console` 加 `#feature-health`、`#queue-explain-btn`；`brief` 加 `[data-section="neighborhood"]`、`#approve-semantics`。

**acceptance fixture 扩展**（为了让 `agent:[data-causal] === 1` 是真的）：`buildFixture` 在实现提交之后追加第三次确定性提交 —— 改 `C001` 的正文一行，`runGit(add) + runGitCommit('spec: reword C001 to exercise stale propagation')`，然后 `scanWorkspace(db, root)`，并断言 `C002` 的最新 evidence 满足 `invalidated_at IS NOT NULL AND invalidation_source = 'specs/demo/spec.md#C001'`；`FIXTURE_TARGETS` 增 `stale: 'specs/demo/spec.md#C002'`。

- **决策**：扩展 fixture，让真实 Chrome 真的看见一条因果链。*被否决的备选*：只断言 `[data-causal] === 0`（不改 fixture）—— 那样 P1 的端到端链路（迁移 → 传播 → gate → status → 渲染）在浏览器门里一次都没被走过，"browser acceptance 通过"就与 P1 无关。
- 连带影响自查清单：`C002` 由 auto-pass 变为 agent-lane stale ⇒ `counts.autoPass` 2→1、`counts.agent` 1→2（两者都在 pageSize 2 的第 1 页内）；`/specs` 仍是 5 条 = 3 页（`第 1/3 页` 断言不变）；映射 diff 仍是 5 个（第三次提交不碰 impl 文件）；`worktreeDirty` 结束仍为 false；`brief` 页目标仍是 C004，未受影响。
- 保留 `--focus-steps 8`、`--diff-count 5`、`--disclosure blame-diff=true` 与七页参数不变。

### 7.4 必须一并修的浏览器门根因缺陷（F16）

`captureFocusOrder` 用 `e.id || e.tagName.toLowerCase()` 当元素身份，`validateFocusOrder` 又把重复身份判为错误。而 `appNav` 渲染 5 个无 id 的 `<a>`（`render-console.ts:44-51`），`briefNav` 5 个（`render-brief.ts:163-175`）—— 前 8 个 tab stop 里必然出现多个 `"a"`，`:focus-order` 断言在**当前代码上就会红**。这不是本轮引入的（T015/T016/T017 在 `tasks.md` 中仍未勾选，浏览器门自 T014 以来没有对现版 UI 跑过），但本轮往同样的页面加了更多可聚焦控件，不处理就无法诚实宣称浏览器验收通过。

根因修复（`scripts/ui-browser-check.ts`，只改身份表达式，不改 `validateFocusOrder` 的语义与其单测）：

```ts
const FOCUS_IDENTITY_EXPRESSION = `(()=>{
  const e=document.activeElement;
  if(!e||e===document.body)return "";
  if(e.classList&&e.classList.contains("skip"))return "skip-link";
  if(e.id)return e.id;
  const all=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')];
  const i=all.indexOf(e);
  return e.tagName.toLowerCase()+"["+(i>=0?i:"?")+"]";
})()`
```

- **决策**：修身份函数。*被否决的备选 A*：给 nav 的 5 个锚点各发一个 id —— 治标：任何无 id 的锚点（包括我新加的 feature 行链接、行内 brief 链接）都会复发，而且要动 §6.4 冻结的静态 ID 表。*被否决的备选 B*：放宽 `validateFocusOrder` 不再查重复 —— 那会丢掉它唯一真正在防的东西（focus trap：同一元素被反复聚焦）。改身份后，真 trap 仍然产生重复索引而被抓住，假阳性消失。
- `validateFocusOrder` 与其单测（`tests/ui-browser-check.test.ts:178-187`）一字不改；`captureFocusOrder` 的单测（`:392-407`）注入返回值、不断言表达式文本，同样不受影响。

### 7.5 门序

1. `npx tsc --noEmit`（C005）
2. `node_modules/.bin/vitest run`（含新 oracle 文件）
3. §6.4 manifest 再生成 + 两套 verifier
4. `urtext index/check/verify/status` 在本仓库自举全绿（迁移后）
5. trusted final gate：编译 `$ACC` → 起 acceptance server → Chrome 7 页 × 3 viewport × 2 theme

---

## 8. Dogfood

### 8.1 `specs/urtext/spec.md` 追加 C027（编号冲突已实测，见下）

> **实测冲突**：工作树中 verify-perf 车道已经占用了 `C027`（`## C027 批量与增量验证不得软化证据 <!-- oracle:test:tests/verify-performance.test.ts risk:high refs:…#C004 req:FR002 -->`，未提交）。brief pinned #6 写的是 "new clause C027"，那是在该车道落地之前定的编号。子句 id 是位置标识符、不是语义的一部分：**实施时取当时最小的空闲编号**（若 verify-perf 先合入即 `C028`），标题/正文/oracle/refs/req 一字不改，并同步更新 `tasks.md` 的 `clauses:` 与本文件的引用。不要为了对齐 brief 的字面而与对方争抢同一个号 —— 两条子句都是真实的，冲突的只是计数器。

```markdown
## C027 UI 呈现因果与健康投影 <!-- oracle:test:tests/ui-projection.test.ts risk:high refs:specs/urtext/spec.md#C008,specs/urtext/spec.md#C019,specs/urtext/spec.md#C026 req:FR009,FR012 -->

`urtext ui` 必须把七维裁决状态投影成人可直接判读的低维视图，且全部为渲染投影：
不产生第二事实源，不进入 items、counts、WIP 或退出码。

每条 stale 队列项渲染一句因果链——上游变更 key → 本条证据作废 → 重跑 verify 前不放行；
来源取自与 `invalidated_at` 同一次写入的 `invalidation_source`（一枚印章两列），
FR 直接命中的子句归因到该 FR 而非它自身，历史 NULL 行渲染无来源版本，绝不伪造来源。
Your queue 按 feature 单元渲染证据/元审计/高危批准/未覆盖意图的只读健康行。
clause detail 渲染 defended FR ← 本条 → refs 目标 → 直接依赖的一跳邻域（一跳，非闭包）。
approve/decide 控件旁常驻绑定 HEAD 短 sha 与失效规则的静态说明。
AI 解释对每个人车道条款项与每个 clause detail 可用，只读、fail-closed，
其文本永不进入任何账本（R4 红线）。
```

- refs 选择：`C008`（stale 传播是因果链的事实源）、`C019`（UI 裁决上下文）、`C026`（需求绑定投影，被邻域的 FR 列复用）。三条都是真实语义依赖，方向都是本子句依赖它们 —— 它的断言坏掉不会把它们拉回人工队列。
- 独立 oracle 文件 `tests/ui-projection.test.ts`（MN-6）。

### 8.2 `specs/urtext/tasks.md` 追加 T018

```markdown
- [ ] T018 UI 人类投影：因果链、feature 健康、一跳邻域、AI 解释泛化 <!-- role:coder depends:T017 gate:true clauses:C027 -->
    evidence.invalidation_source 迁移与归因传播、queue 因果句、feature health 只读行、brief 一跳邻域、
    /api/explain queue scope 与全条款控件、批准语义文案、contrast manifest 与真实 browser acceptance。
```

`clauses:` 取 §8.1 的最终编号；`tasks.md` 当前无并发改动，`T018` 空闲。

### 8.3 文档同步（EN + ZH 各 4 处，共 8 个文件）

| 文件 | 改动 |
|---|---|
| `docs/SYNTAX.md:141` | 把该条改写为"invalidation stamp = `invalidated_at` + `invalidation_source`，同一次 UPDATE 写入；legacy 行 source 为 NULL" |
| `docs/zh-CN/SYNTAX.md:108-109` | 同上中文 |
| `docs/wiki/mechanisms/02-registry.md:58-62` | "the single mutable column" 已成谎言 → 改为"the single mutable stamp（两列）" |
| `docs/zh-CN/wiki/mechanisms/02-registry.md:58-62` | 同上 |
| `docs/wiki/mechanisms/03-verifier.md:26-30` | 列清单补 `invalidation_source`；"single exception" 改为"single invalidation stamp" |
| `docs/zh-CN/wiki/mechanisms/03-verifier.md:26-30` | 同上 |
| `docs/wiki/mechanisms/04-linker-impact.md:54-55` | 补"戳同时记录 originating key；FR 直接命中归因到 FR" |
| `docs/zh-CN/wiki/mechanisms/04-linker-impact.md:50-51` | 同上 |

外加 `src/verifier.ts` 自身的 doc comment（§1.1 已给全文）。命令集不变，故 `docs/wiki/guides/03-command-reference.md` 与 C015 的 `command-coverage` oracle 不受影响。

### 8.4 实施顺序

1. `verifier.ts` 迁移 → `linker.ts` 归因 → `gate.ts` → `status.ts`（纯数据层，先绿 `linker/status/gate/verifier` 四个测试）
2. `review-ui.ts`（`UiClause` 两字段、`directDependents`、`toNeighbor`、`handleExplain`）+ `contracts.ts`
3. `render-console.ts`（P1 句、P2 段、P4 控件、P5 文案）+ `console-script.ts`
4. `render-brief.ts`（P3 邻域、P4 拆分、P5 文案）+ `brief-script.ts` + `theme.ts`
5. `tests/ui-projection.test.ts` 新建；既有测试按 §7.2 更新
6. contrast manifest fixture 扩展 → §6.4 再生成 → 两套 verifier
7. `ui-browser-check.ts` selector/AX 表 + focus 身份修复；acceptance fixture stale 扩展
8. Dogfood：C027 + T018 + 8 个文档
9. 收尾：tsc → 全量 vitest → 自举 index/check/verify/status → trusted final gate

---

## 9. 风险与边界

| # | 风险 | 处置 |
|---|---|---|
| R1 | **legacy NULL 来源**：升级前打的戳没有来源 | 渲染"上游变更 → … 证据作废"，永不编造；`WHERE invalidated_at IS NULL` 保证既有戳不被回填（§7.1 有专门测试） |
| R2 | **stale 只在 agent 车道**（F5），pinned #1 的 "human/agent" 在 human 侧不可达 | 实现放共享的 `queueRow` 机械满足合同；本文件显式记录该事实，不做无法兑现的宣称 |
| R3 | **feature 数量爆炸**：一个仓库 200 个 feature ⇒ 200 行健康表头压掉首屏 | 健康区块**不参与分页**（与 Uncovered intent 同规则，round-2 MN-2），但行数 = feature 数而非 clause 数（自举仓当前 3 个）；若真出现，后续可加 `URTEXT_UI_FEATURE_HEALTH_MAX_ROWS` —— 本轮不预置未被证明需要的阈值 |
| R4 | **无 brief 的 item 上点解释**：unmapped hunk 没有 clause key | 不渲染按钮（`kind === 'clause'` 才渲染）；即使伪造请求，`handleExplain` 的 `key.lastIndexOf('#') <= 0` 挡在 400，`buildBrief` 拒绝挡在 409 |
| R5 | **子句存在但 brief 拒绝**（not_ready / link_error）时点解释 | 409 + 原始拒绝文案原样回显到 `aria-live` 输出，fail-closed，不降级成"通用解释" |
| R6 | **queue prompt 体积**：队列无上界，`omp` 走 argv 传 prompt（ARG_MAX） | `queueExplainMaxItems()` 默认 40，可用 `URTEXT_EXPLAIN_QUEUE_MAX_ITEMS` 覆盖；截断事实写进 prompt 本身（"以下只列前 N 条"），模型不会误以为看到了全部 |
| R7 | **因果句 i18n**：整个 UI 硬编码中文 | 保持一致（不引入 copy 表）；来源 key 与子句 key 是 ASCII 标识符，`esc()` 后直接嵌入，中文外壳不影响可读性 |
| R8 | **注入**：来源 key 来自 spec 路径/子句 id，可能含 `<`、`&` | 所有插值统一走 `esc()`；`tests/ui-projection.test.ts` 有专门的 `<script>` 注入用例 |
| R9 | **health 分母为 0**：新仓库/全 manual feature | 渲染"不适用"muted chip，绝不显示 ✓（D2：空态不得渲染绿色结论） |
| R10 | **一跳查询多打一次 DB**：每次 brief 页 +1 次窄查询 | 单条 id-scoped 查询，走 `clause_refs` 主键前缀；不重建 liveGraph（round-2 MN-5）；404/409 路径完全不触发 |
| R11 | **fixture 扩展的连带影响** | §7.3 给出逐项自查清单（autoPass/agent 计数、页数、diff 数、worktree 洁净） |
| R12 | **两套哈希实现分叉** | 本轮不改文件清单；再生成程序第 3 步强制两个门都跑（`scripts/full-test.sh` 不跑浏览器门 —— 写进实施注记） |
| R13 | **explain 并发** | 每个按钮各自 disable + 独立 `<output>`；共享 picker 只读值；无全局状态，无请求取消需求（浏览器 tab 关闭即结束） |
| R14 | **`ClauseDecision` 加必填字段**是导出类型的形状变化 | 只有 `adjudicate` 构造它；读侧全部兼容；`src/index.ts` 导出面一字不动 |
| R15 | **并发车道冲突**：verify-perf 正在同一工作树改 `src/verifier.ts`（`input_fingerprint` + `--incremental` + test batching）、`src/oracle-runner.ts`、`src/cli.ts`、`specs/urtext/spec.md`（新子句） | 本轮只在 `verifier.ts` 追加两行（schema 一列 + 迁移一块），与其改动无重叠；`specs/urtext/spec.md` 的子句号必须在实施时复核（对方可能已占用 C027 → 顺延），`tasks.md` 任务号同理；`src/cli.ts`/`oracle-runner.ts` 本轮一字不动 |

---

## 10. Weaknesses I know about

1. **P1 在 `/` 页不可达，而 pinned #1 的字面读法暗示它可达。** 我用共享 `queueRow` 机械满足了合同，但如果 owner 的真实意图是"human 车道也要看到因果"，那就需要动 `AGENT_ORDER`/lane 判定（`src/status.ts:43,126`）—— 那是 C016 的语义变更，远超本轮范围。我选择了不动语义并公开记录，对手可以合理地攻击这是"满足字面、绕过意图"。

2. **归因是"BFS 首达者赢"，多根时带任意性。** 一条子句同时被两个独立上游变更命中时，它只显示其中一个来源。我论证了确定性（种子顺序确定 ⇒ 结果确定）和可测性，但没有做多来源聚合。真实世界的"一次提交改了三处 spec"场景下，因果句会漏说两个 culprit。

3. **`invalidation_source` 存的是字符串 key，不是外键。** 目标子句/FR 后来被删除或改名时，来源字符串会变成悬空引用，而 UI 会照样渲染它。这在审计意义上是对的（历史事实就是当时那个 key），但用户点不动、也无从跳转 —— 我没有为它渲染链接，正是因为无法保证目标仍然存在。

4. **P2 的"元审计一致率"分母用 `decisionVerdict === 'n/a'` 反推 manual 性。** 这是对 `gate.ts:153-157` 实现细节的耦合：如果将来 gate 给非 manual 子句也填 `decisionVerdict`，这个分母会静默变错而没有任何测试会红（除非我在 `tests/ui-projection.test.ts` 里显式锁死这条等价关系 —— 计划里锁了，但那是一条"实现细节测试"，本身就是味道）。更干净的做法是给 `UiClause` 加 `oracleKind`，代价是又一个 fixture 字段。

5. **`buildSpecImpactView` 现在有六个位置参数。** 我选择了向后兼容而不是可读性。第七个参数出现时这个函数就该重构成选项对象，而那需要一次公开面破坏性变更 —— 我把这笔债留给了下一轮。

6. **acceptance fixture 的 stale 扩展是对一个高杠杆共享 fixture 的改动。** 它同时被 `ui-acceptance-fixture.test.ts`、`ui-acceptance-server.test.ts` 和浏览器门消费。我列了自查清单，但清单是我读代码推出来的，没有实跑（planning 阶段不跑测试套件）。`counts.autoPass 2→1` 这类断言如果藏在我没读到的行里，会在实施时才炸。

7. **F16 的浏览器门缺陷我只在计划里断言，没有实证。** `captureFocusOrder` 是 real-Chrome-only 路径，vitest 覆盖不到它的表达式。我的推理链（5 个无 id 锚点 → 5 个 `"a"` → duplicate）是纯静态阅读；如果 Chrome 的 tab 序因为某种原因先经过带 id 的元素、8 步之内没吃到两个锚点，那么这个"缺陷"就不成立，而我的修复就是一次无来由的 scripts 改动。我认为概率很低，但它确实是本计划里唯一一处"改动理由无法在 planning 阶段被证伪"的地方。

8. **P4 的 prompt 质量无法被测试守卫。** 我能测三个小标题在不在、约束句在不在、模型没被调用时是否 fail-closed，但"这段解释对人有没有用"没有 oracle。C027 因此在 P4 维度上只是形状锁，不是质量锁 —— 这与 R4 当初砍掉理解层的理由（叙述不可判定）是同一个问题，我没有解决它，只是把它关在了注册表外面。

9. **健康行不分页、不设上限。** R3 里我拒绝预置阈值（YAGNI），但这意味着一个 200-feature 的 monorepo 会拿到一个 200 行的首屏区块。我赌的是自举仓和早期采用者都在个位数 feature 量级；这个赌注没有数据支撑。

10. **`console.explain.item` 的可见分支只在一个 fixture 上覆盖，且我没有为"unmapped 行不渲染按钮"登记分支。** 我论证了"不渲染不是新可见分支"，但这条论证同样可以被用来少登记任何东西 —— 它是一个滑坡的起点，只是这次我停在了合理的位置。

11. **我把 owner pinned 的 `C027` 编号改成了"取当时最小空闲号"。** 这是对 pinned contract #6 字面文本的偏离，理由是并发车道已经在未提交的工作树里占了这个号（§8.1 有实测证据）。如果 owner 的意图是"C027 这个号归 UI 投影，verify-perf 让号"，那我做了错误的仲裁 —— 我选了不阻塞、不争抢，但这确实是一次未经确认的合同解释。
