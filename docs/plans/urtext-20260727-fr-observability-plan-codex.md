# Urtext FR Observability 技术计划（Codex lane，round 2）

- 日期：2026-07-27
- 性质：planning only；`.urtext/fr-observability-brief.md` 的 Pinned contract 是唯一产品裁决，本文件只决定实现形状。
- 基线事实：FR/`req:` 已落入 registry/linker/status；`src/linker.ts:93-153` 已能在 live graph 上解析 bare/explicit req edge，`src/status.ts:185-199` 已把 `counts.uncovered` 与 `uncoveredRequirements` 放入 `urtext.status/1`，但 `src/cli.ts:647-673` 仍只接受 `C\d+`，`src/ui/render-console.ts:198-224` 与 `src/ui/render-brief.ts:132-160` 尚未投影 FR 数据。
- 边界：不改 grammar、`SYNTAX.md`、status JSON schema、退出码语义或 items/WIP；不加依赖；保持 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；实现阶段采用小范围 diff。

## 1. Impact：linker API、CLI target 与输出合同

### 1.1 选择独立的 FR impact API

保留现有公开函数 `impact(db, ClauseKey): ImpactReport` 及其 `source/affectedClauses/affectedTasks` 形状不变（`src/linker.ts:48-54,290-329`）。在 `src/linker.ts` 新增 `impactRequirement`，不把 `RequirementKey` 塞进 `impact()` union；这样 `Brief.impact`（`src/brief.ts:70-77`）、root export 与所有现有 clause caller 都不需要分支，也能保证 `impact <path>#C<n>` 的 stdout 逐字不变。

核心类型与查询如下；这不是伪码：

```ts
export interface RequirementImpactReport {
  source: RequirementKey
  /** Every live clause whose req edge uniquely resolves to source. */
  directClauses: ClauseKey[]
  /** directClauses followed by their reverse clause_refs closure, deduplicated. */
  affectedClauses: ClauseKey[]
  /** Same task projection and ordering used by clause impact(). */
  affectedTasks: ImpactReport['affectedTasks']
}

export type RequirementImpactOutcome =
  | { kind: 'found'; report: RequirementImpactReport }
  | { kind: 'unknown_requirement'; target: RequirementKey }

const uniqueClauseKeys = (clauses: ClauseKey[]): ClauseKey[] => {
  const seen = new Set<string>()
  return clauses.filter((clause) => {
    const key = keyOf(clause.specPath, clause.clauseId)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const tasksCiting = (db: Database, clauses: readonly ClauseKey[]): ImpactReport['affectedTasks'] => {
  const taskStmt = db.prepare(
    `SELECT t.file_id, t.title, t.clauses
     FROM tasks t
     JOIN (
       SELECT spec_path, MAX(revision) AS revision
       FROM revisions WHERE file_kind = 'tasks' GROUP BY spec_path
     ) latest ON latest.spec_path = t.spec_path AND latest.revision = t.revision
     WHERE t.spec_path = ?
     ORDER BY t.seq`
  )
  const affectedTasks: ImpactReport['affectedTasks'] = []
  const seenTasks = new Set<string>()
  for (const clause of clauses) {
    const feature = featureOf(clause.specPath)
    if (feature === null) continue
    const taskPath = `specs/${feature}/tasks.md`
    const rows = taskStmt.all(taskPath) as { file_id: string; title: string; clauses: string }[]
    for (const row of rows) {
      const cited: unknown = JSON.parse(row.clauses)
      if (!Array.isArray(cited) || !cited.includes(clause.clauseId)) continue
      const dedupe = `${taskPath}#${row.file_id}#${clause.clauseId}`
      if (seenTasks.has(dedupe)) continue
      seenTasks.add(dedupe)
      affectedTasks.push({
        specPath: taskPath,
        fileId: row.file_id,
        title: row.title,
        clauseId: clause.clauseId,
      })
    }
  }
  return affectedTasks
}

export const impactRequirement = (
  db: Database,
  target: RequirementKey
): RequirementImpactOutcome => {
  const graph = liveGraph(db)
  if (!graph.declaredReqs.has(keyOf(target.specPath, target.reqId))) {
    return { kind: 'unknown_requirement', target }
  }

  const directClauses = uniqueClauseKeys(
    graph.reqEdges.flatMap((edge) => {
      const candidates = resolveReq(graph, edge)
      const resolved = candidates.length === 1 ? candidates[0] : undefined
      return resolved?.specPath === target.specPath && resolved.reqId === target.reqId
        ? [{ specPath: edge.spec_path, clauseId: edge.clause_id }]
        : []
    })
  )
  const affectedClauses = uniqueClauseKeys([
    ...directClauses,
    ...reverseClosure(graph.edges, directClauses),
  ])
  return {
    kind: 'found',
    report: {
      source: target,
      directClauses,
      affectedClauses,
      affectedTasks: tasksCiting(db, affectedClauses),
    },
  }
}
```

同时把 `impact()` 的现有 `src/linker.ts:294-325` task loop 原样提取为 `tasksCiting()`，并改成 `tasksCiting(db, [source, ...affectedClauses])`。其 dedupe key 仍含 `clauseId`，所以同一 task 若同时引用两个 affected clause，仍像今天一样输出两行；不能趁机“修正”这一行为。

`impactRequirement()` 的直接集合只接受 `resolveReq()` 恰好返回一个候选的 edge：explicit `path#FR<n>` 精确命中；bare `FR<n>` 继续使用 feature-local resolution；dangling 和 ambiguous edge 都不是“守卫”，不会污染 direct 集合。target 本身用 `declaredReqs` 验证，因此不存在或最新 revision 已 tombstone 的 FR 返回 typed failure，CLI 再映射为 exit 1。

**Design decision D1**：新增 `impactRequirement()`，拒绝把 `impact()` 扩成 `ClauseKey | RequirementKey`；后者会把 union 分支传播到 `Brief`、UI 和 root package consumers，且更难证明 clause 输出未变。

**Design decision D2**：affectedClauses 明确包含 direct，另以 `directClauses` 区分；拒绝沿用 clause report 的“source excluded”含义，因为 pinned contract 要 direct 位于 closure 输出内。

**Design decision D3**：复用 `resolveReq()`，拒绝直接按 `to_spec/to_req` SQL 字符串匹配；后者会漏掉 bare unit-local binding，也会错误计入 ambiguous binding。

### 1.2 CLI 只新增 FR parser，保留 clause 分支原文

在 `src/cli.ts` 邻近 `parseClauseTarget`（`src/cli.ts:112-119`）加入明确的 explicit-path parser：

```ts
const parseRequirementTarget = (
  target: string | undefined
): { specPath: string; reqId: string } | null => {
  const hash = target?.lastIndexOf('#') ?? -1
  if (!target || hash <= 0) return null
  const specPath = target.slice(0, hash)
  const reqId = target.slice(hash + 1)
  return /^FR\d+$/.test(reqId) ? { specPath, reqId } : null
}
```

这天然拒绝 bare `FR007`、空 path、`C`/`FR` 混写和尾随文本。`impact` command 分支按 clause-first 分派；clause 的原代码和所有字符串保持不动，只在它外围增加 FR 分支：

```ts
if (command === 'impact') {
  const clause = parseClauseTarget(argv[1])
  const requirement = clause === null ? parseRequirementTarget(argv[1]) : null
  if (clause === null && requirement === null) {
    console.error(
      `Usage: urtext impact <spec-path>#C<n>|<spec-path>#FR<n>\n\nGot: ${argv[1] ?? '(nothing)'}`
    )
    return 1
  }
  scanWorkspace(db, workspaceRoot)

  if (clause !== null) {
    const { specPath, clauseId } = clause
    const report = impact(db, { specPath, clauseId })
    if (report.affectedClauses.length === 0 && report.affectedTasks.length === 0) {
      console.log(`No clause refs ${specPath}#${clauseId} and no task cites it.`)
      return 0
    }
    if (report.affectedClauses.length > 0) {
      console.log('Affected clauses (reverse closure):')
      for (const affected of report.affectedClauses) {
        console.log(`  ${affected.specPath}#${affected.clauseId}`)
      }
    }
    if (report.affectedTasks.length > 0) {
      console.log('Affected tasks:')
      for (const task of report.affectedTasks) {
        console.log(`  ${task.specPath} ${task.fileId} ${task.title} (cites ${task.clauseId})`)
      }
    }
    return 0
  }

  if (requirement === null) throw new Error('unreachable impact target')
  const outcome = impactRequirement(db, requirement)
  if (outcome.kind === 'unknown_requirement') {
    console.error(
      `No live requirement ${outcome.target.specPath}#${outcome.target.reqId} — run \`urtext index\` first.`
    )
    return 1
  }
  const { report } = outcome
  const direct = new Set(report.directClauses.map((item) => `${item.specPath}#${item.clauseId}`))
  console.log(`Requirement impact: ${report.source.specPath}#${report.source.reqId}`)
  if (report.affectedClauses.length === 0) {
    console.log('Affected clauses (direct + reverse closure): none')
  } else {
    console.log('Affected clauses (direct + reverse closure):')
    for (const affected of report.affectedClauses) {
      const key = `${affected.specPath}#${affected.clauseId}`
      console.log(`  [${direct.has(key) ? 'direct' : 'transitive'}] ${key}`)
    }
  }
  if (report.affectedTasks.length > 0) {
    console.log('Affected tasks:')
    for (const task of report.affectedTasks) {
      console.log(`  ${task.specPath} ${task.fileId} ${task.title} (cites ${task.clauseId})`)
    }
  }
  return 0
}
```

`unreachable` guard 只证明前面两个 exhaustive branches 的类型收窄，不会被合法 argv 触发。FR 存在但零 direct clause 是正常的 uncovered intent：打印 `none`、exit 0。只有 malformed target 或不存在/tombstoned target exit 1。

更新 `src/cli.ts:13-14,71-72` 的 usage/header 为 `#C<n>|#FR<n>`，并同步：

- `docs/wiki/guides/03-command-reference.md:61-75` 与中文对应段；
- `docs/wiki/mechanisms/04-linker-impact.md:7-34` 与中文对应段，补 FR edge → direct clauses → refs closure 图义；
- exit-code table给 `impact` 增“不存在/tombstoned FR target”一行。`scripts/oracle-wiki.sh command-coverage` 仍能 grep 到同一个 `urtext impact`，不改 command allowlist（`src/cli.ts:174-190`）。

**Design decision D4**：FR stdout 用单一 affected 列表加 `[direct]/[transitive]` 标记，拒绝输出两个重复 clause 列表；这同时满足“direct included”和“可区分”。

**Design decision D5**：不为 FR impact 增 `--json`；拒绝在本轮暗中创建未被 owner brief 固定的新 CLI schema。

## 2. UI：从 registry/status 到两个只读 surface

### 2.1 Clause detail 的 resolved/broken req contract

当前 `BriefManifest.reqs` 只有 raw target 字符串（`src/brief.ts:52-68,271-304`），而 `buildBrief()` 会在 target spec 存在 link error 时拒发 hash（`src/brief.ts:208-215`）。不能为了显示 broken req 放宽该安全门。做法是向 linker 增加只读解析查询，并由 `review-ui` 独立投影：成功 brief 显示 resolved title；link-error page 显示 broken state，但仍无 hash、review/decide 控件。

`liveGraph()` 的 requirement query 从只取 `req_id` 改为取 `req_id,title`，并维护 `requirementsByKey`；`uncoveredRequirements()` 改从这张 map/既有 revision 顺序投影，输出顺序不变。新增真实 linker 类型与查询：

```ts
export type RequirementBindingResolution =
  | { state: 'resolved'; rawTarget: string; line: number; target: RequirementCoverage }
  | { state: 'dangling'; rawTarget: string; line: number }
  | {
      state: 'ambiguous'
      rawTarget: string
      line: number
      candidates: RequirementCoverage[]
    }

export const resolveClauseRequirements = (
  db: Database,
  source: ClauseKey
): RequirementBindingResolution[] => {
  const graph = liveGraph(db)
  return graph.reqEdges
    .filter((edge) => edge.spec_path === source.specPath && edge.clause_id === source.clauseId)
    .map((edge) => {
      const rawTarget = edge.to_spec === '' ? edge.to_req : `${edge.to_spec}#${edge.to_req}`
      const candidates = resolveReq(graph, edge)
      if (candidates.length === 0) return { state: 'dangling', rawTarget, line: edge.line }
      const titled = candidates.flatMap((candidate) => {
        const requirement = graph.requirementsByKey.get(keyOf(candidate.specPath, candidate.reqId))
        return requirement === undefined ? [] : [requirement]
      })
      const target = titled.length === 1 ? titled[0] : undefined
      if (target !== undefined) {
        return { state: 'resolved', rawTarget, line: edge.line, target }
      }
      return { state: 'ambiguous', rawTarget, line: edge.line, candidates: titled }
    })
}
```

在 `src/ui/contracts.ts` 加 UI-owned discriminated union，并把它加入 `SpecImpactView`：

```ts
export type RequirementBindingView =
  | {
      state: 'resolved'
      rawTarget: string
      target: { specPath: string; reqId: string; title: string }
    }
  | { state: 'dangling'; rawTarget: string }
  | {
      state: 'ambiguous'
      rawTarget: string
      candidates: { specPath: string; reqId: string; title: string }[]
    }

export interface SpecImpactView {
  schema: 'urtext.spec-impact/1'
  // existing fields unchanged
  requirementBindings: RequirementBindingView[]
}
```

`line` 是 linker diagnostic，不送浏览器；UI 没有源行导航需求。`src/review-ui.ts:113-130` 的 `buildSpecImpactView()` 在现有三个位置参数后加第四个默认参数 `requirementBindings: RequirementBindingView[] = []`，避免破坏当前 caller；`handleBrief()` 在 `buildBrief()` 前后都调用 `resolveClauseRequirements(db,target)`：

```ts
export interface BriefApiResult {
  status: number
  body:
    | {
        ok: true
        briefHash: string
        text: string
        risk: 'low' | 'high'
        reviewable: boolean
        facts: ReviewFacts
        view: SpecImpactView
      }
    | { error: string; requirementBindings: RequirementBindingView[] }
}

// inside handleBrief, after target validation
const requirementBindings = resolveClauseRequirements(db, target).map((binding) => {
  if (binding.state === 'resolved') {
    return { state: 'resolved', rawTarget: binding.rawTarget, target: binding.target }
  }
  if (binding.state === 'ambiguous') {
    return { state: 'ambiguous', rawTarget: binding.rawTarget, candidates: binding.candidates }
  }
  return { state: 'dangling', rawTarget: binding.rawTarget }
}) satisfies RequirementBindingView[]

const outcome = buildBrief(db, root, target)
if (outcome.kind === 'refused') {
  return {
    status: outcome.code === 'unknown_clause' ? 404 : 409,
    body: { error: `[${outcome.code}] ${outcome.message}`, requirementBindings },
  }
}

// success body
view: buildSpecImpactView(outcome.brief, dependents, navigation, requirementBindings)
```

Malformed/unknown clause errors return `requirementBindings: []`; this is an additive internal JSON property, not a status-schema change。`src/ui-server.ts:201-220` 把 error bindings 传入 error renderer；无新 endpoint/pathClass/write path。

`src/ui/render-brief.ts` 新增一个共享 pure renderer，success 和 link-error page 都调用：

```ts
const requirementBindingsHtml = (bindings: readonly RequirementBindingView[]): string => {
  const content = bindings.length === 0
    ? '<p data-state="req-empty">No req bindings available.</p>'
    : `<ul>${bindings.map((binding) => {
        if (binding.state === 'resolved') {
          const key = `${binding.target.specPath}#${binding.target.reqId}`
          return `<li data-state="req-resolved">${statusChip('ok', '✓', 'resolved')} <code>${esc(key)}</code> ${esc(binding.target.title)}</li>`
        }
        if (binding.state === 'dangling') {
          return `<li data-state="req-dangling">${statusChip('danger', '✗', 'broken')} <code>${esc(binding.rawTarget)}</code> — target does not exist</li>`
        }
        const candidates = binding.candidates
          .map((candidate) => `${candidate.specPath}#${candidate.reqId} ${candidate.title}`)
          .join('；')
        return `<li data-state="req-ambiguous">${statusChip('danger', '✗', 'broken')} <code>${esc(binding.rawTarget)}</code> — ambiguous: ${esc(candidates)}</li>`
      }).join('')}</ul>`
  return `<section data-section="requirement-bindings" aria-labelledby="requirement-bindings-title"><h2 id="requirement-bindings-title">Requirement bindings / 需求绑定</h2>${content}</section>`
}
```

需要把 `statusChip` 加入 `render-brief.ts:9` import。success page 在 evidence chip 后、mappings 前插入 `requirementBindingsHtml(view.requirementBindings)`。error renderer 保持单参数兼容，第二参数缺省时让既有 unknown-clause HTML 逐字不变；只有有 binding diagnostic 时追加 section：

```ts
export const renderBriefErrorPage = (
  message: string,
  requirementBindings: readonly RequirementBindingView[] = []
): string => pageShell({
  title: 'urtext brief error',
  header: '<header><h1 id="error-title">无法生成裁决简报</h1></header>',
  nav: '<nav aria-label="页面导航"><a href="/">← console</a> · <a href="/specs">查看全部 Specs</a> · <a href="/">刷新状态</a></nav>',
  main: `<main id="main"><p role="alert" data-state="error">${esc(message)}</p>${
    requirementBindings.length > 0 ? requirementBindingsHtml(requirementBindings) : ''
  }</main>`,
})
```

**Design decision D6**：broken binding 显示在 fail-closed 409 detail/error shell，拒绝让 `buildBrief()` 在 link error 下发 approvable hash；可观测性不能削弱 C017/C018 的安全边界。

**Design decision D7**：UI 接收结构化 resolver 结果，拒绝解析 `renderBriefText()` 的 `req:` 行；这沿用 `review-ui.ts:7-15` 的 domain-truth 纪律。

**Design decision D8**：`urtext.spec-impact/1` 只加内部 property、不升版本；拒绝制造第二个 HTTP schema，因为 consumer 是同仓 renderer，owner 已允许 UI contract 加 props。

### 2.2 Queue page 的 Uncovered intent

数据路径不新增查询：`buildUiSnapshot()` 已把 `buildStatus()` 原对象放进 `snapshot.status`（`src/review-ui.ts:59-91`），而 status 已带 `{counts.uncovered, uncoveredRequirements}`（`src/status.ts:185-199`）。`src/ui/render-console.ts` 只做 server-side projection：

```ts
const uncoveredIntentSection = (snapshot: UiSnapshot): string => {
  const requirements = snapshot.status.uncoveredRequirements
  const content = requirements.length === 0
    ? '<p data-state="uncovered-empty">✓ all live requirements are defended</p>'
    : `<ul>${requirements.map((requirement) => {
        const key = `${requirement.specPath}#${requirement.reqId}`
        return `<li data-requirement="${esc(key)}"><code>${esc(key)}</code> ${esc(requirement.title)}</li>`
      }).join('')}</ul>`
  return `<section id="uncovered-intent" aria-labelledby="uncovered-intent-title"><h2 id="uncovered-intent-title">Uncovered intent (${snapshot.status.counts.uncovered})</h2>${content}</section>`
}

const summary = (snapshot: UiSnapshot): string => {
  const wip = /* existing branch unchanged */
  return `<p>${snapshot.status.counts.human} for you, ${snapshot.status.counts.agent} for the agent, ${snapshot.status.counts.autoPass} auto-pass · ${snapshot.decided}/${snapshot.totalManual} manual decided · ${snapshot.status.counts.uncovered} uncovered intent</p>${wip}`
}

// queue branch only
const items = snapshot.status.items.filter((item) => item.lane === 'human')
w = win(items.length)
body = `${uncoveredIntentSection(snapshot)}${queueSection(items.slice(w.start, w.end), w)}`
```

selectors/contracts：仅 `/` 新增 `#uncovered-intent`、`#uncovered-intent-title`、`[data-state="uncovered-empty"]`、`[data-requirement="<path>#FR<n>"]`；`/agent`、`/specs`、`/decisions` 不重复此 section。列表不进入 `status.items`，不改变 human/agent count、WIP、page count 或 exit code。现有 queue `?page=N` 仍只切 human items；uncovered section 在每个 queue page 完整重复，因此翻页不会把 intent 混进 WIP，也不会令它不可达。

**Design decision D9**：Uncovered intent 是 queue page 的独立 `<section><ul>`，拒绝伪装成 queue table row；后者会违反“不进入 items/WIP”并污染分页总数。

**Design decision D10**：本轮不为 uncovered list 新增第二个 paginator，拒绝复用 queue 的 `page` 参数；一个 query 同时切两组集合会产生含混 URL。大列表代价列入 §6/§7。

## 3. Contrast manifest：可见分支、消费者与精确重生成

### 3.1 当前真实合同与本轮变更

`tests/ui-component-contrast.test.ts:78-121` 和 `scripts/ui-browser-check.ts:112-166` 独立实现同一合同：固定顺序读取以下七个源文件，使用 `label + "\0" + byteLength + "\0" + bytes + "\0"` framing；再 hash canonical `JSON.stringify(fixtureMatrix)`；render hash 则按 fixture id 顺序 hash fresh renderer 的精确 UTF-8 输出。`docs/plans/urtext-20260724-ui-redesign.md:174-176` 明确禁止换行/源码/HTML normalization。现有 hash 源集合是：

1. `src/ui/theme.ts`
2. `src/ui/html.ts`
3. `src/ui/pagination.ts`
4. `src/ui/render-console.ts`
5. `src/ui/render-brief.ts`
6. `src/ui/console-script.ts`
7. `src/ui/brief-script.ts`

本轮 `render-console.ts`、`render-brief.ts` 的任一字节都会使 `sourceContractSha256` 过期；queue/brief fixture output 会使 `renderContractSha256` 过期。`contracts.ts`、`review-ui.ts`、`ui-server.ts` 不在 source hash list，这是既有合同，不擅自扩表；它们的可见影响由 renderer fixtures/render hash 与 HTTP/browser tests 捕获。

`tests/ui-component-contrast.test.ts:161-204` 的 `CANONICAL_BRANCHES` 增加：

```ts
'console.uncoveredIntent.empty',
'console.uncoveredIntent.nonEmpty',
'brief.requirementBindings.resolved',
'error.requirementBindings.dangling',
'error.requirementBindings.ambiguous',
```

manifest matrix 的精确调整：

- 所有 9 个 console fixture 的 `status.counts` 补 `uncovered`，`status` 补 `uncoveredRequirements`，因为 renderer 现在实际读取它们；`console-quiet` 覆盖 empty，`console-busy` 放一个带转义字符的 uncovered FR 覆盖 nonEmpty。
- 每个 brief fixture 的 `view` 补 `requirementBindings`；`brief-full` 放 resolved target/title 并声明 resolved branch。
- 扩展 `ErrorFixture` 为可选 `requirementBindings?: RequirementBindingView[]`，`renderFixture()`/`renderContrastFixture()` 传给 `renderBriefErrorPage`；新增 deterministic `error-broken-requirements` fixture，同时放 dangling 与 ambiguous（候选包含两个不同 spec/title），覆盖两个 broken branch。原 `error-page` 继续证明无附加 diagnostics 的旧 error 输出。
- 新 markup 只使用现有 `body/main`、`code` 与 `[data-tone="ok|danger"]` selector-token rule；`REGISTERED_PAIRS`/`SELECTOR_DETECTORS` 不新增规则。现有 brief 页已有 ok/danger consumer；error broken fixture 首次让 `[data-tone="danger"]` 在 error page 可达，因此 manifest 必须新增 `e-danger-default` consumer（fixture=`error-broken-requirements`, tokens=`danger/danger-bg`）。双向枚举若再发现其他新 selector，测试必须失败，不能先猜 consumer 行。

**Design decision D11**：新增 visible branch IDs 和 deterministic fixtures，拒绝只重算两串 hash；fixtureMatrix 正是防止“hash 新但分支漏掉”的第二道合同。

### 3.2 禁止手改 hash 的 regeneration procedure

仓库当前只有两个可重算 verifier，没有提交一个 hash writer；因此不能靠运行失败测试后复制 `actual`，也不能手工编辑 JSON 两个 hash 字段。实现的第一步是在 `scripts/` 增加 `ui-contrast-manifest.ts`，并加入 `scripts/tsconfig.ui-acceptance.json:15` 的 external-outDir include。writer 只做一件事：读取并验证已编辑的 schema/fixtureMatrix/consumers，按上述七文件/framing/renderer 算法计算两个 digest，然后在原始 JSON bytes 中各精确替换一次顶层 `sourceContractSha256` / `renderContractSha256` 的 64-hex value，写临时文件并 atomic rename；这样不重排人工维护的 fixture/consumer formatting。它拒绝非 `/3` schema、重复 fixture id、未知 page、字段缺失或多次匹配，并在 `--check` 模式只比较不写。

精确命令（从 repo root）为：

```sh
ACC=$(mktemp -d /tmp/urtext-contrast-XXXXXX)
node_modules/.bin/tsc -p scripts/tsconfig.ui-acceptance.json --outDir "$ACC"
node "$ACC/scripts/ui-contrast-manifest.js" \
  --source-root "$PWD" \
  --manifest "$PWD/tests/ui-contrast-manifest.json" \
  --write
node "$ACC/scripts/ui-contrast-manifest.js" \
  --source-root "$PWD" \
  --manifest "$PWD/tests/ui-contrast-manifest.json" \
  --check
rm -rf "$ACC"
```

`--write` 是唯一允许更新 `sourceContractSha256/renderContractSha256` 的路径；code review 拒绝任何只改这两个 JSON 字符串而没有 generator invocation 的 patch。生成后按顺序运行：

```sh
node_modules/.bin/vitest run tests/ui-component-contrast.test.ts
node_modules/.bin/vitest run tests/ui-browser-check.test.ts
```

随后按 `scripts/ui-acceptance.md:8-29` 编译到外部 `$ACC`，按 `:31-108` 建 fixture/启动 compiled acceptance server，再使用 `:146-159` 的 `ui-browser-check-wrapper.mjs` 七页 invocation。现有 7 个 page name 保持不变；`scripts/ui-browser-check.ts` 的 page-specific selector 表新增：console 必有 `#uncovered-intent`，brief 必有 `[data-section="requirement-bindings"]`。fixture 在 demo spec 增一个不带 clause binding 的 `FR999`，让真实 console 浏览器页走 non-empty branch；C004 detail 继续走 resolved branch。broken states 由 deterministic contrast fixture + pure/HTTP tests 覆盖，不把故意 link-broken spec 注入整套 acceptance repo，避免令全部 approvable brief 失效。

**Design decision D12**：补一个使用现有算法的 deterministic writer，拒绝从 Vitest mismatch 手抄 hash；仓库现状没有安全的写入命令，继续依赖人工无法满足 owner 的禁止项。

**Design decision D13**：不新增第八个 browser page，拒绝把故意 broken spec 放进共享 acceptance fixture；broken branch 用 renderer/HTTP/contrast matrix 证明，真实浏览器仍覆盖两个实际改变的成功页面。

## 4. Test plan、C025/C026 证据与验收顺序

### 4.1 Targeted tests

| 文件 | 新增/修改的可判定合同 |
|---|---|
| `tests/linker.test.ts` | `impactRequirement`：explicit edge、bare unit-local edge、同 FR 重复 edge 去重；direct BFS 顺序；direct 包含于 affected；refs 多层 transitive；task 投影与 clause impact 相同；FR 存在但零 clause；不存在 FR；latest tombstone FR；bare ambiguous/dangling edge 不计 direct。并保留现有 `tests/linker.test.ts:306-338` 两个 clause impact 用例逐字断言。 |
| `tests/fr-impact.test.ts` | C025 主 oracle。用真实 in-memory registry 驱动 linker；对 FR target parser 的 path-required/`^FR\d+$` matrix 与 exact formatter lines 断言 `[direct]/[transitive]`、none、task；用注入 logger 的小 helper 证明 unknown outcome → stderr + 1。现有 clause branch继续由旧 linker assertions和 stdout snapshot守护。 |
| `tests/spec-impact-interactions.test.ts` | C026 主 oracle。现有真实 repo fixture断言 `/brief` view/HTML 含 resolved `specs/x/spec.md#FR001` 与 title；额外 DB fixture制造 dangling/ambiguous req，断言 409 shell 显式 `req-dangling/req-ambiguous`、无 brief hash/review controls；queue 断言 uncovered key/title和空态，且 status items/counts.human/wip/exit语义不变。 |
| `tests/ui-brief.test.ts` | 给 shared `view` fixture补 requirementBindings；分别断言 resolved、dangling、ambiguous、empty，escaping，唯一 `aria-labelledby` target；`renderBriefErrorPage(message)` 单参输出仍无 req section。 |
| `tests/review-ui.test.ts` | `handleBrief` success JSON 的 typed binding；link_error 的 additive error bindings；unknown clause bindings 空数组；resolved title来自 requirement row而非 raw string。 |
| `tests/ui-console.test.ts` | queue only 的 section ownership；0/1/N uncovered、escaping、`counts.uncovered` title；翻到 `?page=2` section仍完整而 queue row slice不变；其他三 route 不含 section；WIP/human/agent/table caption不受 uncovered 数量影响。现有“每 route 一个 main list table”仍成立，因为新 surface 用 `<ul>`。 |
| `tests/ui-server.test.ts` | real GET `/` 的 uncovered list/empty；real GET `/brief` resolved binding；独立 link-broken fixture 409 body含 broken state；`/api/brief` error additive property。Host/CSRF/pathClass矩阵无变化。 |
| `tests/ui-html.test.ts` | 无 theme token 变更；只在需要时补 `statusChip`复用断言，不改 contrast literal。 |
| `tests/ui-component-contrast.test.ts` + JSON | 五个 canonical branch、fixture 类型、全 fixture 新 status/view 字段、generator freshness、双向 selector reachability、light/dark ≥4.5。 |
| `tests/ui-browser-check.test.ts` | page-specific selectors 加 console/brief 两项；stale source hash negative、manifest verification仍通过两个独立 digest assertion。 |
| `tests/ui-acceptance-fixture.test.ts` / `tests/ui-acceptance-server.test.ts` | demo fixture的 uncovered FR 确定性；compiled server实际 `/` 与 C004 `/brief` 含新 selector；clauses 仍 5 条，所以 `/specs` 仍恰 3 页。 |
| `tests/package-surface.test.ts` / `tests/package-consumer.test.ts` | root export集合不增不减；installed server HTTP smoke额外断言新 markup，不 deep-import internal linker resolver/generator。 |

CLI 辅助 parser/formatter 放 `src/fr-impact-cli.ts` 并由 `src/cli.ts` 和 `tests/fr-impact.test.ts` 共用；不把 `src/cli.ts` 改成 importable main，以免为测试改变 process bootstrap。该 helper 不进入 `src/index.ts` root export。

### 4.2 实现与验证顺序

1. 先写 `tests/fr-impact.test.ts` 与 linker cases，随后实现 linker API、task helper、FR parser/formatter和 CLI branch；单独核对现有 C target预期字符串。
2. 写 requirement resolver与 `review-ui/contracts/render-brief` tests，再实现 success/409 两条 data flow；先证明 broken page 无 guarded controls。
3. 写 queue empty/non-empty/pagination tests，再实现 `uncoveredIntentSection()`；确认没有 status/domain改动。
4. 更新 server/acceptance fixture/browser selector tests与英中 wiki。
5. 更新 contrast canonical branches/fixtures/consumers；只通过 §3.2 writer生成 hashes，`--check` 证明幂等。
6. 追加 C025/C026/T017，运行 index/check/verify migration gate。

实现完成后的精确 gate（本 planning turn 不运行）为：

```sh
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/vitest run tests/linker.test.ts tests/fr-impact.test.ts
node_modules/.bin/vitest run tests/spec-impact-interactions.test.ts tests/review-ui.test.ts tests/ui-brief.test.ts tests/ui-console.test.ts tests/ui-server.test.ts
node_modules/.bin/vitest run tests/ui-component-contrast.test.ts tests/ui-browser-check.test.ts tests/ui-acceptance-fixture.test.ts tests/ui-acceptance-server.test.ts
node_modules/.bin/vitest run tests/package-surface.test.ts tests/package-consumer.test.ts
node_modules/.bin/tsc -p tsconfig.json
node dist/cli.js index
node dist/cli.js check
node dist/cli.js verify specs/urtext/spec.md#C025
node dist/cli.js verify specs/urtext/spec.md#C026
node dist/cli.js verify
sh scripts/full-test.sh
```

最后执行 §3.2 的真实 `ui-browser-check-wrapper.mjs` flow；七页 × viewport `{1440,1024,390}` × scheme `{light,dark}` 全部 assertions green，contrast manifest 的 source/render assertions green，console/brief 新 selectors在 computed DOM/AX evidence 中可达。C025 另做 dogfood smoke：

```sh
node dist/cli.js impact specs/urtext/spec.md#FR013
node dist/cli.js impact specs/urtext/spec.md#FR012
```

前者必须至少把 C020/C021/C023/C025 标为 direct，并将其 refs dependents 标 transitive（具体集合以最终 live graph 为准，不在计划里伪造固定数量）；后者必须包含 C019/C026 direct。不存在目标 smoke 必须 stderr 清楚且 exit 1。

**Design decision D14**：C025 用新、窄的 FR impact test file作 oracle，拒绝把所有 CLI 行为塞进已有 300+ 行 linker suite；主 oracle仍同时执行真实 linker query与 CLI formatter。

**Design decision D15**：browser gate覆盖真实改变的 queue/success brief，broken req由 HTTP+renderer+contrast fixture覆盖；拒绝把单一测试层冒充全覆盖。

## 5. Dogfood migration：C025、C026 与 task

在 `specs/urtext/spec.md` 的 C024 后追加以下原文：

```md
## C025 FR 影响可机械查询 <!-- oracle:test:tests/fr-impact.test.ts risk:low req:FR013 -->

`urtext impact <spec-path>#FR<n>` 必须列出所有唯一解析到该 FR 的直接守卫子句，
并从这些子句沿 `clause_refs` 给出包含 direct 的反向影响闭包及其 checklist tasks；
direct/transitive 必须可区分。不存在或 tombstoned FR 明确拒绝并退出 1，既有
`impact <spec-path>#C<n>` 输出保持逐字兼容。

## C026 UI 呈现需求绑定与未覆盖意图 <!-- oracle:test:tests/spec-impact-interactions.test.ts risk:high refs:specs/urtext/spec.md#C019 req:FR012 -->

`urtext ui` 的 clause detail 必须把每条 `req:` 显示为带 FR title 的 resolved binding；
dangling/ambiguous binding 显式显示 broken 且不得获得可批准 hash 或操作控件。Your queue
必须从 `urtext.status/1` 的 `uncoveredRequirements/counts.uncovered` 显示 Uncovered intent
列表与空态；这些 intent 不进入 items、human/agent count、WIP 或退出码。
```

在 `specs/urtext/tasks.md` 的 T016 后追加：

```md
- [ ] T017 FR impact 与 UI observability <!-- role:coder depends:T016 gate:true clauses:C025,C026 -->
    FR direct+refs closure 查询、CLI C/FR target 分派、detail req resolved/broken 状态、queue uncovered intent、contrast manifest 与真实 browser acceptance。
```

迁移顺序必须是 source/tests/docs先完成，再追加 clauses/task，再 `index → check → targeted C025/C026 verify → full verify`。不能先把 oracle 指到不存在或红着的测试文件。

**Design decision D16**：C026 refs C019 并保持 risk high，拒绝建一条低风险孤立 UI clause；它与现有人工可达性/contrast/browser lane 同生共验。

**Design decision D17**：新增 T017 而不改写/勾选 T015/T016 的历史状态；拒绝借本功能顺手“修正”既有 checklist 进度。

## 6. 风险、边界条件与回滚

| 风险/边界 | 计划行为 | 阻塞验证/缓解 |
|---|---|---|
| FR 存在但零 defending clause | found + empty direct/affected/tasks，stdout `none`，exit 0；这正是机械读出的 uncovered。 | linker + formatter tests；与 status uncovered结果交叉断言。 |
| FR 不存在或最新 revision tombstoned | `unknown_requirement`，清楚 stderr，exit 1。 | 两个 registry revision tests；CLI outcome test。 |
| bare req 在 feature 内 ambiguous | 该 edge不是 direct defender；detail显示两个或更多 candidates的 broken state。 | 两文件同 feature/同 FR id fixture；linkWorkspace仍报 `ambiguous_req`。 |
| explicit req path dangling | 不计 direct；detail 409显示 `req-dangling`，仍无 brief-hash/controls。 | review-ui/server negative tests。 |
| 一个 clause 多次绑定同 FR | direct clause去重；task行为仍按 affected clause一次。 | uniqueClauseKeys test。 |
| direct clauses互相 refs或图中有环 | multi-source BFS 的 visited 预置所有 direct，closure不会把 direct重新标 transitive，也不会死循环。 | diamond/cycle test。 |
| FR fan-out很大 | 算法是一次 liveGraph建图 + req edge scan + multi-source BFS，即 O(V+E)，不会对每个 direct重复 BFS；stdout仍有意完整、无分页/截断。 | 生成 1k direct + chain 的 bounded unit test只断言数量/顺序，不做 timing承诺。 |
| task JSON损坏 | 沿用 clause impact 的 `JSON.parse` 行为，不在本轮改变错误面。 | 现有行为保留；不扩大 scope。 |
| requirement title含 HTML | 所有 path/id/title/candidate string经 `esc()`；data attribute也 escape。 | `<script>`, quote, ampersand fixtures。 |
| link error来自同 spec其他 clause | 当前 detail仍因 `buildBrief` spec-level guard而409；只展示当前 clause的 req bindings和全局 error message，不假装可批准。 | HTTP fixture含 sibling broken edge。 |
| uncovered intent很多 | 独立列表不污染 queue paginator，但每个 queue page完整重复，HTML大小线性增长。 | 100-item render test；若真实repo超过阈值再单独设计 `intent-page`，本轮不静默截断。 |
| queue `?page=N` 与 uncovered data同时变化 | page只作用 human items；刷新会取新 snapshot，section可变化，queue slice仍clamp。 | ui-console + ui-server跨页并集测试。 |
| status schema漂移 | 不改 `StatusReport`/JSON；只消费现有字段。 | status snapshot/JSON tests保持原 schema `/1`。 |
| manifest source/render stale | generator `--check` + independent Vitest + independent browser verifier三重拒绝。 | 禁止手改 hashes；source、matrix、renderer任一变化 negative test。 |
| generator和browser verifier共享错误 | component contrast test保留独立 hash实现，不 import generator。 | 三者对同一 framing结果一致；fixture branch/consumer双向枚举。 |
| rollback | source/UI/manifest/docs/spec/task属于一个 feature commit；回滚整 commit恢复旧 renderer/hash/clauses。registry append-only历史不删除，重新 index 会追加恢复 revision。 | 回滚演练只在隔离 fixture，不改生产 `.urtext`。 |

安全不变量：所有 UI 值 escape；没有新 POST/CSRF面；broken page无 review/decide控件；resolver是只读；browser/fixture raw artifacts继续放 repo外；无动态安装；不改 `THEME_CSS` token就不声称新色彩合同。

**Design decision D18**：大 fan-out完整输出，拒绝隐式截断；impact 是机械审计结果，静默省略比输出大更危险。

**Design decision D19**：回滚以整 feature commit为单位，拒绝只回滚 JSON hash或 clauses；两者单独回滚都会制造 stale manifest/悬空 oracle。

## 7. Weaknesses I know about

1. `impactRequirement()` 仍像现有 linker 一样把 live graph 和完整结果放内存；O(V+E) 但不是 streaming。极大 workspace 会有内存和终端输出压力，本轮没有 pagination/`--json`/limit contract。
2. Uncovered intent 列表不分页，并在 queue 的每个 `?page=N` 重复。它保证全部 intent始终可见且不污染 WIP，但数千 FR 时页面会长；若真实数据触发，应单独设计无歧义的 `intent-page` query，而不是偷偷截断。
3. broken req 显示在 fail-closed 409 shell，不是一个可操作的完整 brief。这是刻意保住 approvable-hash guard 的取舍，但用户不能在同一页查看 mappings/evidence；修好 link error 后刷新才能回完整 detail。
4. requirement resolved title 是显示投影，不加入 `BriefManifest`/brief-hash。FR text change已有 stale传播保护现有证据，但“title本身必须进入批准hash”不是本轮 pinned contract，仍可能值得后续单独裁决。
5. 现仓库没有 committed contrast hash writer；本计划必须先新增 writer才有可审计的 regeneration command。writer本身是新代码，需要独立 test保证只改两个 digest、原样保留 fixture/consumer，并由现有两套 verifier反证。
6. 既有 sourceContractSha256不覆盖 `contracts.ts`、`review-ui.ts`、`ui-server.ts`。本轮尊重该固定列表；可见 output由 render hash/HTTP/browser捕获，但纯 contract drift只靠 TypeScript与对应 unit tests，不由 source hash感知。
7. C025 的主 oracle能完整覆盖 linker + FR CLI parser/formatter，但为了不改变 `src/cli.ts` 的 process bootstrap，不直接 import/run整个 CLI main；最终 built-CLI dogfood smoke和 full-test承担最后一段 wiring 证明。
