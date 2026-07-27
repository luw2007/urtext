# Urtext 需求层（FR）技术方案 — Planner A（Opus lane）

> 目标：让需求（FR）成为注册表一等公民，并把 clause→FR 可追溯性做成与 P1
> "无 oracle 的子句 = 错误"对称的 fail-closed 约束。
> 输入：owner contract brief（pinned contract 1–8 不可辩论）。
> 本文包含真实 TypeScript 代码、SQLite DDL 与可直接落盘的 spec 迁移文本。

---

## 0. 全局设计判断（先说结论）

四条判断决定了整个方案的形状，其余细节都是它们的推论。

**判断 1：FR 与 clause 共用一条修订链，但分表存储。**
FR 声明写在同一个 `specs/<feature>/*.md` 里，因此同一个 `content_hash`、同一个
`(spec_path, revision)` 同时覆盖 FR 与 clause，一次编辑是一次原子修订。
*被否决的备选*：为 FR 单开 `fr_revisions` 链——同一文件将出现两条可能互相不同步的
"当前活跃修订"，且要重新发明一套 tombstone 语义，收益为零。

**判断 2：`req:` 的 unit-local 解析发生在 link 阶段，不在 index 阶段。**
`indexClauseFile` 原样存下写了什么（`to_spec=''` 表示裸 `FR<n>`），
由 linker 在全 workspace 活跃快照上解析。
*被否决的备选*：像 `indexTaskFile` 的 `unitClauseIds` 那样由 scanner 预先喂入
unit 级 FR 索引——会强制 scanner 拆成"先全解析、再全索引"两趟，
并改变 `indexClauseFile` 的公开签名（`tests/linker.test.ts` 直接调用它），
爆炸半径远大于收益。link 阶段解析还顺带让 `unknown_req` 与 `unknown_ref`
拿到完全相同的语义（目标被改名/删除而引用方文件未变，同样能抓到）。

**判断 3：FR 是 stale 闭包图上的源节点，与 clause 共享同一次 BFS。**
`req:` 边方向是 clause → FR（clause 依赖 FR）。FR 文本变更时，
一次反向闭包同时得到"绑定该 FR 的子句"与"这些子句的 refs 下游"。
关键差异：clause 文本变更会铸出新修订、verify 自然重跑，所以变更源本身不打戳；
而 **FR 文本变更不改变任何 clause 的 `text_hash`**，因此绑定子句自己必须被打戳——
它们正好是闭包里的直接依赖者，无需特例代码。
*被否决的备选*：为 FR 单写一个 `propagateRequirementStale`——会与 clause 传播产生
重复打戳，且丢掉"FR 变 → 绑定子句 → 该子句的 refs 下游"的传递性。

**判断 4：未覆盖 FR 是报告区，不是队列项。**
它进 `StatusReport.uncoveredRequirements`，不进 `items`、不计入 `counts`/`wip`、
不改变退出码。
*被否决的备选*：作为 `lane:'human'` 的 StatusItem——`urtext status` 在 `items` 非空时
退出 1，于是"刚写下一条还没有子句的需求"会立刻把操作台判红，
正好惩罚这个特性要鼓励的工作流；同时污染 WIP 指标（WIP 度量的是待裁决项，
不是待补齐的意图）。

---

## 1. 数据模型与迁移策略

### 1.1 新增两张表（`src/registry.ts` 的 `REGISTRY_SCHEMA` 尾部追加）

```sql
CREATE TABLE IF NOT EXISTS requirements (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  req_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  text_hash   TEXT    NOT NULL DEFAULT '',
  body        TEXT,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, req_id),
  FOREIGN KEY (spec_path, revision) REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clause_reqs (
  spec_path   TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  clause_id   TEXT    NOT NULL,
  -- '' = unit-local bare `FR<n>`; otherwise the workspace-relative target path.
  to_spec     TEXT    NOT NULL,
  to_req      TEXT    NOT NULL,
  line        INTEGER NOT NULL,
  PRIMARY KEY (spec_path, revision, clause_id, to_spec, to_req),
  FOREIGN KEY (spec_path, revision) REFERENCES revisions (spec_path, revision) ON DELETE CASCADE
);
```

`requirements` 与 `clauses` 结构对称（少了 oracle/risk/refs——FR 不可判定），
`clause_reqs` 与 `clause_refs` 结构对称（`to_spec` 多了 `''` 这一含义）。

`to_spec` 用 `''` 而不是 `NULL` 表示 unit-local：SQLite 在普通表的 PRIMARY KEY 列上
允许 NULL 且多个 NULL 互不相等，`INSERT OR IGNORE` 的去重（`req:FR001,FR001`）会失效。
*被否决的备选*：`to_spec TEXT NULL` + 额外 `scope` 列——两列表达一个事实，
且 PK 去重仍然要绕开 NULL 语义。

> **规划期实测**（`sqlite3 :memory:`，PK `(a,b,c)`、`b` 可空）：连续两次
> `INSERT OR IGNORE VALUES ('s', NULL, 'FR001')` 落了 **2 行**。NULL 方案确实
> 静默丢失去重，这是实测结论，不是推断。同一份 DDL 在 `.urtext/registry.sqlite`
> 的副本上执行通过，重复执行 `CREATE TABLE IF NOT EXISTS` 是 no-op，
> `revisions` 历史与既有行零变化，旧修订的 `requirements` 行数为 0。

### 1.2 对既有 `.urtext/registry.sqlite` 的迁移

**不需要迁移代码。** `openRegistry` 执行的是 `CREATE TABLE IF NOT EXISTS`，
新表在既有库上直接出现；既有的 `revisions` / `clauses` / `clause_refs` 一行不动。
本仓当前实测链长（`sqlite3 .urtext/registry.sqlite`）：

```
specs/distill/spec.md    rev 1
specs/distill/tasks.md   rev 1
specs/loops/spec.md      rev 5
specs/urtext/spec.md     rev 4
specs/urtext/tasks.md    rev 6
```

这些历史修订在新表里永远是零行——这是**事实正确**的：它们确实没有 FR。
`priorReqHashes` 对不存在的修订查询得到空 Map，等价于"之前什么都没有，
所以什么都没变"，与 rev 1 / tombstone 之后的既有语义一致。

`text_hash` 那条 `ALTER TABLE` 式的 additive migration（M1 遗产）保持原样不动：
它处理的是"表已存在但缺列"，与本次"新增表"是两类问题。
*被否决的备选*：给 `requirements` 也写一段 `pragma_table_info` 探测——
新表由 `IF NOT EXISTS` 保证，探测代码永远走不到 else 分支，是死代码。

### 1.3 `text_hash` 语义

FR 的 `text_hash = sha256(title + '\n' + body)`，与 clause 完全同一个函数。
`title` 是剥掉 anchor 之后的标题文本——因此 **anchor-only 的编辑不是文本变更**。
这条对迁移至关重要：给 19 条既有子句加 `req:`，
不会改变任何 clause 的 `text_hash`，不会触发一次 stale 风暴（见 §8.5）。

`src/registry.ts` 里把私有 helper 改名以承载第二个调用方：

```ts
const textHash = (title: string, body: string | null): string =>
  `sha256:${createHash('sha256').update(`${title}\n${body ?? ''}`, 'utf8').digest('hex')}`
```

（原 `clauseTextHash`，一处调用点，改名比让 FR 复用一个叫 clause 的函数诚实。）

---

## 2. Parser 变更（`src/clause-parser.ts`）

### 2.1 新类型

```ts
export interface ClauseReq {
  /** Workspace-relative spec path, or null for a unit-local bare `FR<n>`. */
  path: string | null
  reqId: string
}

/**
 * A requirement declaration — prose intent, deliberately NOT decidable. An
 * `oracle:` on one is a category error: intent is what a clause defends, not
 * something a runner can judge.
 */
export interface ParsedRequirement {
  /** Stable in-file id, e.g. `FR001`. Unique within the file. */
  reqId: string
  /** 1-based order of appearance among requirements. */
  seq: number
  title: string
  /** Heading level 1-6, kept for round-tripping. */
  level: number
  /** Prose between this heading and the next heading; null when empty. */
  body: string | null
  /** 0-based line index of the heading, for error anchoring. */
  line: number
}
```

`ParsedClause` 在 `refs` 之后加一行：

```ts
  refs: ClauseRef[]
  /** Requirements this clause defends. At least one, or `missing_requirement`. */
  reqs: ClauseReq[]
```

`ParsedClauseFile` 加一行：

```ts
export interface ParsedClauseFile {
  clauses: ParsedClause[]
  requirements: ParsedRequirement[]
  errors: ClauseParseError[]
}
```

### 2.2 错误码

```ts
export interface ClauseParseError {
  code:
    | 'missing_oracle'
    | 'invalid_oracle_kind'
    | 'invalid_risk'
    | 'duplicate_clause_id'
    | 'malformed_anchor'
    | 'malformed_ref'
    | 'missing_requirement'
    | 'malformed_req'
    | 'duplicate_req_id'
    | 'oracle_on_requirement'
    | 'risk_on_requirement'
  clauseId?: string
  /** Set instead of `clauseId` for requirement-declaration errors. */
  reqId?: string
  line: number
  message: string
}
```

`reqId` 是新的可选字段而不是复用 `clauseId`：CLI 的 building 报错只打印
`{line, code, message}`（`src/cli.ts:697-707`、`:725-733`），
所以增字段零成本，而复用 `clauseId` 装一个 `FR001` 是永久的谎。

### 2.3 正则与解析函数

```ts
// `## FR001 Title …` — a requirement declaration. Disjoint from CLAUSE_LINE:
// a heading id starts with either `C` or `FR`, never both.
const REQUIREMENT_LINE = /^(#{1,6})\s+(FR\d+)\b\s*(.*)$/
```

```ts
const parseReqs = (
  value: string | undefined,
  line: number,
  clauseId: string
): { reqs: ClauseReq[]; errors: ClauseParseError[] } => {
  const reqs: ClauseReq[] = []
  const errors: ClauseParseError[] = []
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const hash = trimmed.lastIndexOf('#')
    // Bare `FR<n>` resolves inside the feature unit; `<path>#FR<n>` is exact.
    const path = hash === -1 ? null : trimmed.slice(0, hash)
    const reqId = hash === -1 ? trimmed : trimmed.slice(hash + 1)
    if ((hash !== -1 && !path) || !/^FR\d+$/.test(reqId)) {
      errors.push({
        code: 'malformed_req',
        clauseId,
        line,
        message: `Clause "${clauseId}" req "${trimmed}" is not "FR<n>" or "<path>#FR<n>".`,
      })
      continue
    }
    reqs.push({ path, reqId })
  }
  return { reqs, errors }
}
```

`missing_requirement` 的触发条件必须是"解析后一个有效绑定都没有 **且** 没有报过
malformed"，不能像 `parseOracle` 那样只判 `value === undefined`——
否则 `req:`（空值）和 `req:,,` 会静默通过，成为 fail-open 缺口：

```ts
    const { reqs, errors: reqErrors } = parseReqs(fields.req, i, clauseId)
    errors.push(...reqErrors)
    if (reqs.length === 0 && reqErrors.length === 0) {
      errors.push({
        code: 'missing_requirement',
        clauseId,
        line: i,
        message: `Clause "${clauseId}" binds no requirement. A normative clause must declare which intent it defends: req:FR<n> or req:<path>#FR<n>.`,
      })
    }
```

> **规划期实测**（本节 `parseReqs` 与两条正则原样执行）：
> - `CLAUSE_LINE` 与 `REQUIREMENT_LINE` 在 `## FR001 …` / `## C001 …` /
>   `### FR010 …` / `### C101 …` 上互斥命中，无交叉。
> - `FR001` → `[{path:null,reqId:'FR001'}]`；
>   `FR001,specs/b/spec.md#FR002` → 两条；`specs/a/spec.md#FR001` → path 形式正确。
> - `C001` / `#FR001` / `FR` / `a.md#C001` → 全部 `malformed_req`，且
>   `missing_requirement` 条件为 false（不重复报错）。
> - `undefined` / `''` / `',,'` → `missing_requirement` 条件为 true，
>   fail-open 缺口确认被堵住。

### 2.4 主循环：FR 分支

body 抽取逻辑被 clause 与 FR 共用，先提成 helper（原地把 clause 分支里那段
`for (let j = i + 1; …)` 换成调用，行为字节级等价）：

```ts
/** Body = lines until the next heading (any level) or EOF. */
const bodyAfter = (lines: string[], start: number): string | null => {
  const bodyLines: string[] = []
  for (let j = start + 1; j < lines.length; j++) {
    const probe = lines[j]
    if (probe === undefined || ANY_HEADING.test(probe)) break
    bodyLines.push(probe)
  }
  return bodyLines.join('\n').trim() || null
}
```

主循环在 `CLAUSE_LINE` 匹配之前插入 FR 分支：

```ts
export const parseClauseFile = (content: string): ParsedClauseFile => {
  const lines = content.split(/\r?\n/)
  const clauses: ParsedClause[] = []
  const requirements: ParsedRequirement[] = []
  const errors: ClauseParseError[] = []
  const seenIds = new Set<string>()
  const seenReqIds = new Set<string>()
  let seq = 0
  let reqSeq = 0

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (rawLine === undefined) continue

    const reqMatch = rawLine.match(REQUIREMENT_LINE)
    if (reqMatch) {
      const [, hashes = '#', reqId = '', rest = ''] = reqMatch
      const anchorMatch = rest.match(ANCHOR)
      let fields: Record<string, string> = {}
      if (anchorMatch?.[1] !== undefined) {
        const parsed = parseAnchorFields(anchorMatch[1])
        fields = parsed.fields
        for (const issue of parsed.issues) errors.push(toAnchorError(issue, i, { reqId }))
      }
      // A requirement is intent. Decidability fields belong to the clause that
      // defends it — carrying them here would make intent look verifiable.
      if (fields.oracle !== undefined) {
        errors.push({
          code: 'oracle_on_requirement',
          reqId,
          line: i,
          message: `Requirement "${reqId}" carries an oracle. Intent is not decidable — bind the oracle to a clause that declares req:${reqId}.`,
        })
      }
      if (fields.risk !== undefined) {
        errors.push({
          code: 'risk_on_requirement',
          reqId,
          line: i,
          message: `Requirement "${reqId}" carries a risk tier. Risk is a property of the clause that enforces the intent, not of the intent.`,
        })
      }
      if (seenReqIds.has(reqId)) {
        errors.push({
          code: 'duplicate_req_id',
          reqId,
          line: i,
          message: `Requirement id "${reqId}" is declared more than once.`,
        })
      }
      seenReqIds.add(reqId)

      requirements.push({
        reqId,
        seq: ++reqSeq,
        title: rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim(),
        level: hashes.length,
        body: bodyAfter(lines, i),
        line: i,
      })
      continue
    }

    const match = rawLine.match(CLAUSE_LINE)
    if (!match) continue
    // …既有 clause 分支不变，只在 refs 之后插入 §2.3 的 req 段落，
    //   并在 clauses.push({…}) 里加 `reqs,`，body 改为 bodyAfter(lines, i)。
  }

  return { clauses, requirements, errors }
}
```

`toAnchorError` 的 owner 参数收敛为联合类型（一处既有调用点同步改）：

```ts
const toAnchorError = (
  issue: AnchorParseIssue,
  line: number,
  owner: { clauseId: string } | { reqId: string }
): ClauseParseError => ({
  code: 'malformed_anchor',
  ...owner,
  line,
  message: `${'clauseId' in owner ? `Clause "${owner.clauseId}"` : `Requirement "${owner.reqId}"`}: ${issue.message}`,
})
```

### 2.5 明确不做的事

FR anchor 上的 `refs:`、`req:` 以及任何未知字段**被忽略**，不报错。
理由：与既有行为一致——今天 clause anchor 上的 `foo:bar` 也不是错误
（`parseAnchorFields` 收全部，parser 只读它认识的键）。
pinned contract 只钉了 `oracle:` 与 `risk:` 两个 denial，就只做这两个。
*被否决的备选*：FR anchor 走 allowlist（当前为空集）——会与 clause anchor
的开放语义分叉，形成第二套规矩。

---

## 3. Registry 对账（`src/registry.ts`）

### 3.1 `IndexOutcome` 扩展

```ts
  | {
      kind: 'indexed'
      revision: number
      status: 'ready' | 'building'
      errors: (ClauseParseError | TaskParseError | CrossRefError)[]
      changedClauses: string[]
      /**
       * Requirement ids whose text (title+body) differs from the prior live
       * revision — added and removed ids included. Always [] for task files.
       * An FR edit mints no new CLAUSE revision, so the linker must stale the
       * bound clauses from these ids or a changed intent would silently keep
       * green evidence.
       */
      changedRequirements: string[]
    }
```

`indexTaskFile` 的返回值同步补 `changedRequirements: []`（与既有 `changedClauses: []` 并列）。

### 3.2 `indexClauseFile` 主体

前置 hash 快照扩一段：

```ts
  const priorHashes = new Map<string, string>()
  const priorReqHashes = new Map<string, string>()
  if (latest && latest.status !== 'tombstoned') {
    const rows = db
      .prepare('SELECT clause_id, text_hash FROM clauses WHERE spec_path = ? AND revision = ?')
      .all(specPath, latest.revision) as { clause_id: string; text_hash: string }[]
    for (const row of rows) priorHashes.set(row.clause_id, row.text_hash)
    const reqRows = db
      .prepare('SELECT req_id, text_hash FROM requirements WHERE spec_path = ? AND revision = ?')
      .all(specPath, latest.revision) as { req_id: string; text_hash: string }[]
    for (const row of reqRows) priorReqHashes.set(row.req_id, row.text_hash)
  }
```

事务体内，clause 循环里追加 req 边写入，并在 clause 循环之后写 FR：

```ts
  const changedClauses: string[] = []
  const changedRequirements: string[] = []
  db.transaction(() => {
    // …既有 revisions / clauses / clause_refs 插入不变…
    const insertReqEdge = db.prepare(
      `INSERT OR IGNORE INTO clause_reqs (spec_path, revision, clause_id, to_spec, to_req, line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // …在 `for (const ref of clause.refs)` 之后：
    //   for (const req of clause.reqs) {
    //     insertReqEdge.run(specPath, nextRevision, clause.clauseId, req.path ?? '', req.reqId, clause.line)
    //   }

    const insertReq = db.prepare(
      `INSERT INTO requirements (spec_path, revision, req_id, seq, title, text_hash, body, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // Duplicate FR ids keep the revision at `building`; first-wins insert so the
    // PK holds and the broken edit is recorded rather than crashing (same rule
    // the clause loop above applies to duplicate clause ids).
    const insertedReqs = new Set<string>()
    for (const requirement of parsed.requirements) {
      if (insertedReqs.has(requirement.reqId)) continue
      insertedReqs.add(requirement.reqId)
      const hash = textHash(requirement.title, requirement.body)
      if (priorReqHashes.get(requirement.reqId) !== hash) changedRequirements.push(requirement.reqId)
      insertReq.run(
        specPath,
        nextRevision,
        requirement.reqId,
        requirement.seq,
        requirement.title,
        hash,
        requirement.body,
        requirement.line
      )
    }
    // Removed requirements changed too — their bound clauses must re-verify
    // (and will additionally surface as `unknown_req` at check).
    for (const reqId of priorReqHashes.keys()) {
      if (!insertedReqs.has(reqId)) changedRequirements.push(reqId)
    }
  })()

  return {
    kind: 'indexed',
    revision: nextRevision,
    status,
    errors: parsed.errors,
    changedClauses,
    changedRequirements,
  }
```

### 3.3 修订语义与 fail-closed 路径

- **同一条链**：FR 与 clause 共享 `(spec_path, revision)`；`unchanged` no-op、
  `ready`/`building`、tombstone 语义**一字不改**。
- **building 修订仍然写行**：与 clause 现状一致（`liveClauseRevisions` 取的是
  "最新非 tombstone 修订"，不筛 ready）。因此一个 `building` 文件里的 FR
  仍然在活跃图里可见——这正是需要的：`missing_requirement` 让文件红着，
  但已经写对的 FR 不该同时变成 `unknown_req` 的二次伤害。
- **新增的 fail-closed 入口**（全部经由 `parsed.errors.length === 0` 那一行判定，
  无新分支）：`missing_requirement`、`malformed_req`、`duplicate_req_id`、
  `oracle_on_requirement`、`risk_on_requirement`。

---

## 4. Linker（`src/linker.ts`）

这是改动最集中的文件。核心是把 `liveGraph` 从"子句图"升级为"子句+需求图"，
并让 `unknown_req` 与 stale 传播复用同一套解析。

### 4.1 类型

```ts
export interface LinkError {
  code: 'unknown_ref' | 'unknown_req'
  /** Clause file declaring the broken edge. */
  specPath: string
  clauseId: string
  line: number
  message: string
}

export interface RequirementKey {
  specPath: string
  reqId: string
}

export interface RequirementCoverage {
  specPath: string
  reqId: string
  title: string
}

interface ReqEdge {
  spec_path: string
  clause_id: string
  /** '' = unit-local bare `FR<n>`; otherwise the target spec path. */
  to_spec: string
  to_req: string
  line: number
}

/** BFS node — a clause or a requirement; `id` is `C<n>` or `FR<n>`. */
interface GraphNode {
  specPath: string
  id: string
}
```

`GraphNode` 是私有的：闭包遍历对"节点是子句还是需求"无所谓，
但公开的 `ClauseKey.clauseId` 里塞 `FR001` 是撒谎，所以在边界处转换。

`impact()` 内部那个局部 `featureOf` 提到模块作用域（现在两处要用），
函数体一字不动：

```ts
/** `specs/<feature>/…` → `<feature>`; null outside the specs tree. */
const featureOf = (specPath: string): string | null =>
  specPath.match(/^specs\/([^/]+)\//)?.[1] ?? null
```

### 4.2 `liveGraph`

```ts
interface LiveGraph {
  revisions: { spec_path: string; revision: number }[]
  /** `<spec>#C<n>` for every clause of a live revision. */
  declared: Set<string>
  edges: RefEdge[]
  /** `<spec>#FR<n>` for every requirement of a live revision. */
  declaredReqs: Set<string>
  /** `<feature>#FR<n>` → every owning requirement (unit-local resolution). */
  unitReqs: Map<string, RequirementKey[]>
  reqEdges: ReqEdge[]
}

const liveGraph = (db: Database): LiveGraph => {
  const revisions = liveClauseRevisions(db)
  const declared = new Set<string>()
  const edges: RefEdge[] = []
  const declaredReqs = new Set<string>()
  const unitReqs = new Map<string, RequirementKey[]>()
  const reqEdges: ReqEdge[] = []
  const clauseStmt = db.prepare(
    'SELECT clause_id FROM clauses WHERE spec_path = ? AND revision = ?'
  )
  const refStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_clause, line
     FROM clause_refs WHERE spec_path = ? AND revision = ?`
  )
  const reqStmt = db.prepare(
    'SELECT req_id FROM requirements WHERE spec_path = ? AND revision = ?'
  )
  const reqEdgeStmt = db.prepare(
    `SELECT spec_path, clause_id, to_spec, to_req, line
     FROM clause_reqs WHERE spec_path = ? AND revision = ?`
  )
  for (const { spec_path, revision } of revisions) {
    for (const row of clauseStmt.all(spec_path, revision) as { clause_id: string }[]) {
      declared.add(keyOf(spec_path, row.clause_id))
    }
    edges.push(...(refStmt.all(spec_path, revision) as RefEdge[]))
    const feature = featureOf(spec_path)
    for (const row of reqStmt.all(spec_path, revision) as { req_id: string }[]) {
      declaredReqs.add(keyOf(spec_path, row.req_id))
      if (feature === null) continue
      const unitKey = keyOf(feature, row.req_id)
      const owners = unitReqs.get(unitKey)
      if (owners) owners.push({ specPath: spec_path, reqId: row.req_id })
      else unitReqs.set(unitKey, [{ specPath: spec_path, reqId: row.req_id }])
    }
    reqEdges.push(...(reqEdgeStmt.all(spec_path, revision) as ReqEdge[]))
  }
  return { revisions, declared, edges, declaredReqs, unitReqs, reqEdges }
}
```

### 4.3 解析与 `unknown_req`

```ts
/**
 * Resolve one `req:` edge to the requirement declarations it binds. A
 * `<path>#FR<n>` edge binds exactly that declaration; a bare `FR<n>` binds
 * EVERY live declaration of that id inside the clause file's feature unit — a
 * duplicated id therefore fans out instead of silently picking one owner, so
 * stale propagation over-fires rather than under-fires. Empty = `unknown_req`.
 */
const resolveReq = (graph: LiveGraph, edge: ReqEdge): RequirementKey[] => {
  if (edge.to_spec !== '') {
    return graph.declaredReqs.has(keyOf(edge.to_spec, edge.to_req))
      ? [{ specPath: edge.to_spec, reqId: edge.to_req }]
      : []
  }
  const feature = featureOf(edge.spec_path)
  if (feature === null) return []
  return graph.unitReqs.get(keyOf(feature, edge.to_req)) ?? []
}

export const linkWorkspace = (db: Database): LinkError[] => {
  const graph = liveGraph(db)
  const errors: LinkError[] = []
  for (const edge of graph.edges) {
    if (graph.declared.has(keyOf(edge.to_spec, edge.to_clause))) continue
    errors.push({
      code: 'unknown_ref',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      line: edge.line,
      message: `Clause "${edge.clause_id}" refs "${edge.to_spec}#${edge.to_clause}" which does not exist.`,
    })
  }
  for (const edge of graph.reqEdges) {
    if (resolveReq(graph, edge).length > 0) continue
    const target = edge.to_spec === '' ? edge.to_req : `${edge.to_spec}#${edge.to_req}`
    errors.push({
      code: 'unknown_req',
      specPath: edge.spec_path,
      clauseId: edge.clause_id,
      line: edge.line,
      message: `Clause "${edge.clause_id}" binds requirement "${target}" which no live spec file declares.`,
    })
  }
  return errors
}
```

`unknown_req` 追加在 `unknown_ref` 之后，既有 `linkWorkspace` 顺序断言
（`tests/linker.test.ts` 期望 `[['unknown_ref','C001'],['unknown_ref','C002']]`）不受影响。
`check` 的 CLI 侧**零改动**：`unknown_req` 走的是同一个 `report.linkErrors` 数组，
自动被打印、计入 `failures`、进 `--json` envelope（`src/cli.ts:740-744`、`:760`、`:793-799`）。

### 4.4 stale 传播

`reverseClosure` 的节点类型换成 `GraphNode`（私有函数，签名内部化）：

```ts
/** Reverse transitive closure (BFS) of `sources` over the live graph. */
const reverseClosure = (edges: RefEdge[], sources: GraphNode[]): GraphNode[] => {
  const dependents = new Map<string, GraphNode[]>()
  for (const edge of edges) {
    const target = keyOf(edge.to_spec, edge.to_clause)
    const list = dependents.get(target) ?? []
    list.push({ specPath: edge.spec_path, id: edge.clause_id })
    dependents.set(target, list)
  }

  const visited = new Set(sources.map((s) => keyOf(s.specPath, s.id)))
  const queue = [...sources]
  const closure: GraphNode[] = []
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    if (current === undefined) continue
    for (const dependent of dependents.get(keyOf(current.specPath, current.id)) ?? []) {
      const key = keyOf(dependent.specPath, dependent.id)
      if (visited.has(key)) continue
      visited.add(key)
      closure.push(dependent)
      queue.push(dependent)
    }
  }
  return closure
}

/** Resolved `req:` edges as closure edges (clause depends on requirement). */
const reqClosureEdges = (graph: LiveGraph): RefEdge[] => {
  const edges: RefEdge[] = []
  for (const edge of graph.reqEdges) {
    for (const req of resolveReq(graph, edge)) {
      edges.push({
        spec_path: edge.spec_path,
        clause_id: edge.clause_id,
        to_spec: req.specPath,
        to_clause: req.reqId,
        line: edge.line,
      })
    }
  }
  return edges
}
```

```ts
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
  // A requirement is a source node in the same key space: `req:` edges point
  // clause → requirement, so ONE BFS yields both the clauses bound to a changed
  // FR and their transitive `refs` dependents. Unlike a clause text change, an
  // FR edit mints no new clause revision — so the bound clauses must be stamped
  // themselves, and the closure already contains them as direct dependents.
  const sources: GraphNode[] = [
    ...changed.map((clause) => ({ specPath: clause.specPath, id: clause.clauseId })),
    ...changedRequirements.map((req) => ({ specPath: req.specPath, id: req.reqId })),
  ]
  const closure = reverseClosure([...graph.edges, ...reqClosureEdges(graph)], sources)
  // Requirements are never dependents (no edge points at a clause FROM an FR),
  // so every closure member is a clause.
  const staleClauses: ClauseKey[] = closure.map((node) => ({
    specPath: node.specPath,
    clauseId: node.id,
  }))

  const invalidate = db.prepare(
    `UPDATE evidence SET invalidated_at = ?
     WHERE spec_path = ? AND clause_id = ? AND invalidated_at IS NULL`
  )
  let invalidatedEvidence = 0
  db.transaction(() => {
    for (const clause of staleClauses) {
      invalidatedEvidence += invalidate.run(timestamp, clause.specPath, clause.clauseId).changes
    }
  })()
  return { staleClauses, invalidatedEvidence }
}
```

第四个参数带默认值 `[]`：既有全部调用点与测试（`tests/linker.test.ts` 直接调
三参数形式）零改动通过。

> **规划期实测**（按本节代码原样跑闭包）：
> 图为 `coupon/C001 --refs--> billing/C001 --req--> billing/FR001`。
> - 源 = `billing#FR001` → 闭包 `[billing#C001, coupon#C001]`：
>   绑定子句**自己**被打戳（关键——FR 编辑不铸子句新修订），下游也被打戳。
> - 源 = `billing#C001` → 闭包 `[coupon#C001]`：源自身不打戳，既有语义一字未变。
> - 双向环 → 闭包 `[b#C001]`，终止正常。
> - 任一闭包结果中都不含 `FR` 节点，因此 `staleClauses: ClauseKey[]` 的类型是诚实的。

`impact()` 保持只走 `graph.edges`（不含 req 边）：它回答"这条子句变了谁会坏"，
而 FR 永远不是子句的下游，加进去等价于零。边界处做 `ClauseKey ↔ GraphNode` 转换：

```ts
export const impact = (db: Database, source: ClauseKey): ImpactReport => {
  const { edges } = liveGraph(db)
  const affectedClauses: ClauseKey[] = reverseClosure(edges, [
    { specPath: source.specPath, id: source.clauseId },
  ]).map((node) => ({ specPath: node.specPath, clauseId: node.id }))
  // …其余不变；函数内原来的局部 featureOf 定义删除（已提到模块作用域）。
}
```

### 4.5 覆盖率查询

```ts
/**
 * Live requirements that no live clause binds — uncovered intent. Human-lane
 * information (VISION P4): nothing an agent can mechanically fix, so `status`
 * reports it beside the queue rather than inside it.
 */
export const uncoveredRequirements = (db: Database): RequirementCoverage[] => {
  const graph = liveGraph(db)
  const bound = new Set<string>()
  for (const edge of graph.reqEdges) {
    for (const req of resolveReq(graph, edge)) bound.add(keyOf(req.specPath, req.reqId))
  }
  const stmt = db.prepare(
    'SELECT req_id, title FROM requirements WHERE spec_path = ? AND revision = ? ORDER BY seq'
  )
  const uncovered: RequirementCoverage[] = []
  for (const { spec_path, revision } of graph.revisions) {
    for (const row of stmt.all(spec_path, revision) as { req_id: string; title: string }[]) {
      if (bound.has(keyOf(spec_path, row.req_id))) continue
      uncovered.push({ specPath: spec_path, reqId: row.req_id, title: row.title })
    }
  }
  return uncovered
}
```

解析逻辑只有 `resolveReq` 一处实现，linker 是唯一的解析权威——
status 不得复制一份 SQL 版本。

### 4.6 Scanner 接线（`src/scanner.ts`）

```ts
  const changed: { specPath: string; clauseId: string }[] = []
  const changedRequirements: { specPath: string; reqId: string }[] = []
  // …
      if (outcome.kind === 'indexed') {
        for (const clauseId of outcome.changedClauses) changed.push({ specPath, clauseId })
        for (const reqId of outcome.changedRequirements) changedRequirements.push({ specPath, reqId })
      }
  // …
  const stale = propagateStale(db, changed, timestamp, changedRequirements)
```

`ScanReport` 结构不变（`stale` 字段已经承载了结果），
`tests/registry.test.ts` 里那个 `expect(scanWorkspace(...)).toEqual({units:[],outcomes:[],linkErrors:[],stale:…,clauselessUnits:[]})` 深比较继续成立。

---

## 5. Status：未覆盖需求报告

### 5.1 形状（`src/status.ts`）

```ts
import { uncoveredRequirements, type RequirementCoverage } from './linker.js'

export interface StatusReport {
  schema: 'urtext.status/1'
  head: string | null
  items: StatusItem[]
  counts: { agent: number; human: number; autoPass: number }
  wip: { limit: number; exceeded: boolean }
  /**
   * Live requirements with zero live bound clauses. Uncovered intent is a
   * human backlog signal, not a queue item: no agent action closes it, so it
   * stays out of `items`, `counts`, `wip`, and the exit code.
   */
  uncoveredRequirements: RequirementCoverage[]
}
```

`buildStatus` 结尾：

```ts
  return {
    schema: 'urtext.status/1',
    head: input.head,
    items: [...human, ...agent],
    counts: { … },
    wip: { limit, exceeded: human.length > limit },
    uncoveredRequirements: uncoveredRequirements(db),
  }
```

schema tag 保持 `urtext.status/1`：这是纯 additive 字段扩展，
与 `urtext.check/1` 历次加字段（`clauselessUnits`、`unmapped`）同一惯例。
*被否决的备选*：升到 `/2`——会强制改 `tests/ui-contrast-manifest.json` 里 9 处
schema 字面量与两份 wiki 命令参考，收益仅为版本号好看。

### 5.2 CLI 渲染（`src/cli.ts` status 分支，插在 lanes 循环之后、wip 告警之前）

```ts
      if (report.uncoveredRequirements.length > 0) {
        console.log(`\nuncovered intent (${report.uncoveredRequirements.length}):`)
        for (const req of report.uncoveredRequirements) {
          console.log(`  ○ ${req.specPath}#${req.reqId} ${req.title} — no live clause defends this requirement`)
        }
      }
```

退出码那行（`return report.items.length > 0 ? 1 : 0`）一字不改：
未覆盖意图不判红。"nothing pending — the gate should be green" 与
uncovered 区块可以同时出现，这是诚实的——门确实是绿的，
覆盖度是另一根正交的轴。

示例输出：

```text
status @ a1b2c3d — 0 for you, 0 for the agent, 23 auto-pass

uncovered intent (1):
  ○ specs/urtext/spec.md#FR014 需求必须能被追溯到发起人 — no live clause defends this requirement
nothing pending — the gate should be green
```

### 5.3 Brief 补 `req`（`src/brief.ts`）

`BriefManifest` 在 `refs` 之后加 `reqs: string[]`，
读 `clause_reqs` 而不是复用 `clauses.refs` JSON 列：

```ts
  const reqRows = db
    .prepare(
      `SELECT to_spec, to_req FROM clause_reqs
       WHERE spec_path = ? AND revision = ? AND clause_id = ?
       ORDER BY to_spec, to_req`
    )
    .all(target.specPath, clause.revision, target.clauseId) as { to_spec: string; to_req: string }[]
  const reqs = reqRows.map((row) => (row.to_spec === '' ? row.to_req : `${row.to_spec}#${row.to_req}`))
```

`renderBriefText` 在 refs 行之后加一行：

```ts
  if (manifest.reqs.length > 0) lines.push(`  req: ${manifest.reqs.join(', ')}`)
```

理由：C017 的契约是"条文全量"，而人在批准一条高危子句时最该先知道
"它到底在守哪条意图"。一个只存在于 anchor、永不出现在裁决上下文里的 `req:`
正是本系统最痛恨的静默元数据。
**代价**：每条子句的 brief-hash 变一次。可接受——review/decide 都绑 HEAD，
迁移提交本身就会移动 HEAD，没有任何本来有效的批准被这次改动摧毁。

---

## 6. UI 影响（`src/ui/`）：明确什么不动

**结论：`src/ui/` 七个文件一字节不改，`tests/ui-contrast-manifest.json` 不重生成。**

依据（已读代码核对）：

| 事实 | 位置 | 后果 |
|---|---|---|
| console 渲染器只读 `status.wip` / `status.counts` / `status.items` | `src/ui/render-console.ts:54-57`、`:205-211` | 新增字段不改变任何一个字节的 HTML |
| `sourceContractSha256` 只哈希 `src/ui/*` 七个文件 + fixtureMatrix | `tests/ui-component-contrast.test.ts:82-90`、`:110-114` | `src/status.ts` / `src/linker.ts` 改动不触发 |
| `renderContractSha256` 哈希"现场重渲染"的输出 | 同上 `:117-121` | HTML 不变 → 哈希不变 |
| manifest 经 `JSON.parse(...) as ContrastManifest` 进入，非类型校验 | 同上 `:76` | fixture 里 `status` 缺 `uncoveredRequirements` 不产生 tsc 错误 |
| brief 页渲染的是 fixture 里字面量 `input.text` | 同上 `:105` | `renderBriefText` 加 `req:` 行不改 brief 页 HTML |

`UiSnapshot.status` 是 `StatusReport` 的直通引用（`src/review-ui.ts:48`），
新字段随 `/api` JSON 自动流出，不需要渲染器配合。

**故意推迟到 UI lane 的（本次不做，各一行理由）**：

- console 的 "uncovered intent" 区块 / FR 路由 → 会改 `src/ui/render-console.ts` 字节，
  强制重生成 contrast manifest + 重跑 `scripts/ui-browser-check.ts`
  的 3 页 × 3 viewport × 2 theme 验收矩阵，这是 UI 车道的工作量，不是需求层的。
- brief 详情页的 FR 面板（显示 FR 正文而不只是 id）→ 同上，且需要新的
  contrast consumer 登记与对比度证明。
- `urtext impact <spec>#FR<n>` → `impact` 的入参是 `ClauseKey`，
  扩成 FR 目标要动公开签名与 CLI 参数解析，与本次的 fail-closed 主线无关。
- `audit --export` 的 `AuditItem` 携带 FR 正文 → 元审计判的是"证据是否支撑该子句"，
  加 FR 会扩大异源审计包的语义边界，需要单独的 D3 讨论。

---

## 7. 测试方案

### 7.1 必须改的既有测试（fixture 补 FR + `req:`）

这是本方案**最大的一笔成本**，必须摆在明面上：
`missing_requirement` 一旦生效，仓库里每一个内联 clause fixture 都会变 `building`。
实测受影响清单（`grep '## C\d+ .*oracle:' tests scripts`）：

| 文件 | 需要改的 fixture |
|---|---|
| `tests/clause-parser.test.ts` | 全部 11 处（断言 `errors).toEqual([])` 的要加 `req:`；断言单一错误码的也要加，否则多出 `missing_requirement`） |
| `tests/registry.test.ts` | `VALID_CLAUSES` + 4 处 scan fixture |
| `tests/linker.test.ts` | `seedChain` 三个文件 + 6 处内联 |
| `tests/status.test.ts` | `makeRepo` 的 7 处 spec |
| `tests/gate.test.ts` | `setupVerified` 的 11 处 |
| `tests/verifier.test.ts` / `tests/verify-failclosed.test.ts` | 5 处 |
| `tests/brief.test.ts` / `tests/brief-gate.test.ts` | 9 处 |
| `tests/review.test.ts` / `tests/decision.test.ts` / `tests/dwarf.test.ts` | 5 处 |
| `tests/review-ui.test.ts` / `tests/ui-console.test.ts` / `tests/ui-server.test.ts` | 14 处 |
| `tests/spec-impact-interactions.test.ts` / `tests/spec-impact-unmapped.test.ts` | 3 处 |
| `tests/distill.test.ts` | draft 与 promote 目标共 14 处 |
| `tests/package-consumer.test.ts` | 1 处 |
| `scripts/ui-acceptance-fixture.ts` | `DEMO_SPEC` 5 条子句 |

改法固定为最小形：在 fixture 内容前加一行 FR 声明，
给每条子句 anchor 追加 `req:FR001`。例如 `tests/status.test.ts`：

```ts
const makeRepo = (specLines: string[]): string => {
  // …
  writeFileSync(join(root, 'specs/x/spec.md'), ['## FR001 baseline intent', '', ...specLines].join('\n'))
```

```ts
const root = makeRepo(['## C001 pay guard <!-- oracle:cmd:true risk:high req:FR001 -->'])
```

*被否决的备选*：新建 `tests/fixtures.ts` 共享 helper——仓库现有 34 个测试文件
全部自包含，没有任何共享 helper 模块；引入一个是新惯例，不是本特性的职责。

`tests/package-surface.test.ts` 的 `EXPECTED_EXPORTS` 需要按 §7.3 的新导出补齐。

### 7.2 新增测试（守新契约）

**`tests/clause-parser.test.ts`**

```ts
test('an FR heading is a requirement, not a clause', () => {
  const { clauses, requirements, errors } = parseClauseFile(
    ['## FR001 人必须看得见未覆盖的意图', '为什么需要这条。', '## C001 X <!-- oracle:manual req:FR001 -->'].join('\n')
  )
  expect(errors).toEqual([])
  expect(clauses).toHaveLength(1)
  expect(requirements).toEqual([
    { reqId: 'FR001', seq: 1, title: '人必须看得见未覆盖的意图', level: 2, body: '为什么需要这条。', line: 0 },
  ])
})

test('a clause with no req is missing_requirement (symmetric with missing_oracle)', () => {
  const { errors } = parseClauseFile('## C001 X <!-- oracle:manual -->')
  expect(errors).toEqual([
    expect.objectContaining({ code: 'missing_requirement', clauseId: 'C001', line: 0 }),
  ])
})

test('an empty or blank req value is missing_requirement, not silent success', () => {
  for (const anchor of ['req:', 'req:,,']) {
    const { errors } = parseClauseFile(`## C001 X <!-- oracle:manual ${anchor} -->`)
    expect(errors).toEqual([expect.objectContaining({ code: 'missing_requirement' })])
  }
})

test('bare and path req forms parse; anything else is malformed_req', () => {
  const { clauses, errors } = parseClauseFile(
    '## C001 X <!-- oracle:manual req:FR001,specs/b/spec.md#FR002 -->'
  )
  expect(errors).toEqual([])
  expect(clauses[0]?.reqs).toEqual([
    { path: null, reqId: 'FR001' },
    { path: 'specs/b/spec.md', reqId: 'FR002' },
  ])
  for (const bad of ['req:C001', 'req:#FR001', 'req:FR', 'req:a.md#C001']) {
    expect(parseClauseFile(`## C001 X <!-- oracle:manual ${bad} -->`).errors).toEqual([
      expect.objectContaining({ code: 'malformed_req', clauseId: 'C001' }),
    ])
  }
})

test('an oracle or risk on a requirement is a category error', () => {
  expect(parseClauseFile('## FR001 X <!-- oracle:manual -->').errors).toEqual([
    expect.objectContaining({ code: 'oracle_on_requirement', reqId: 'FR001' }),
  ])
  expect(parseClauseFile('## FR001 X <!-- risk:high -->').errors).toEqual([
    expect.objectContaining({ code: 'risk_on_requirement', reqId: 'FR001' }),
  ])
})

test('duplicate requirement ids are flagged', () => {
  const { errors } = parseClauseFile(['## FR001 A', '## FR001 B'].join('\n'))
  expect(errors).toEqual([
    expect.objectContaining({ code: 'duplicate_req_id', reqId: 'FR001', line: 1 }),
  ])
})

test('an FR body runs to the next heading, like a clause body', () => {
  const { requirements } = parseClauseFile(
    ['## FR001 A', 'line one', 'line two', '## FR002 B'].join('\n')
  )
  expect(requirements[0]?.body).toBe('line one\nline two')
  expect(requirements[1]?.body).toBeNull()
})
```

**`tests/registry.test.ts`**

```ts
test('requirements and req edges are persisted per revision', () => {
  indexClauseFile(db, {
    specPath: 'specs/x/spec.md',
    content: ['## FR001 意图', 'why', '## C001 锁 <!-- oracle:manual req:FR001 -->'].join('\n'),
    timestamp: 1,
  })
  expect(db.prepare('SELECT req_id, title FROM requirements WHERE revision = 1').all()).toEqual([
    { req_id: 'FR001', title: '意图' },
  ])
  expect(db.prepare('SELECT clause_id, to_spec, to_req FROM clause_reqs WHERE revision = 1').all()).toEqual([
    { clause_id: 'C001', to_spec: '', to_req: 'FR001' },
  ])
})

test('an FR text change is reported in changedRequirements; a removed FR too', () => {
  const spec = (why: string, extra = '') =>
    ['## FR001 意图', why, extra, '## C001 锁 <!-- oracle:manual req:FR001 -->'].join('\n')
  indexClauseFile(db, { specPath: 'specs/x/spec.md', content: spec('v1'), timestamp: 1 })
  const changed = indexClauseFile(db, { specPath: 'specs/x/spec.md', content: spec('v2'), timestamp: 2 })
  expect(changed.kind === 'indexed' && changed.changedRequirements).toEqual(['FR001'])
  expect(changed.kind === 'indexed' && changed.changedClauses).toEqual([])

  const dropped = indexClauseFile(db, {
    specPath: 'specs/x/spec.md',
    content: '## C001 锁 <!-- oracle:manual req:FR001 -->',
    timestamp: 3,
  })
  expect(dropped.kind === 'indexed' && dropped.changedRequirements).toEqual(['FR001'])
})

test('adding req: to an anchor is not a text change (no stale storm on migration)', () => {
  indexClauseFile(db, {
    specPath: 'specs/x/spec.md',
    content: ['## FR001 意图', '## C001 锁 <!-- oracle:manual -->', 'body'].join('\n'),
    timestamp: 1,
  })
  const after = indexClauseFile(db, {
    specPath: 'specs/x/spec.md',
    content: ['## FR001 意图', '## C001 锁 <!-- oracle:manual req:FR001 -->', 'body'].join('\n'),
    timestamp: 2,
  })
  expect(after.kind === 'indexed' && after.changedClauses).toEqual([])
})

test('an M-era registry without the requirement tables opens and gains them', () => {
  const legacy = new DatabaseConstructor(':memory:')
  legacy.exec(`CREATE TABLE revisions (spec_path TEXT NOT NULL, revision INTEGER NOT NULL,
    file_kind TEXT NOT NULL CHECK (file_kind IN ('clauses','tasks')), content_hash TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready','building','tombstoned')),
    created_at INTEGER NOT NULL, PRIMARY KEY (spec_path, revision))`)
  legacy.prepare(`INSERT INTO revisions VALUES ('specs/x/spec.md', 1, 'clauses', 'sha256:aa', 'ready', 1)`).run()
  openRegistry(legacy)
  expect(legacy.prepare('SELECT COUNT(*) AS n FROM requirements').get()).toEqual({ n: 0 })
  expect(legacy.prepare('SELECT revision, status FROM revisions').all()).toEqual([
    { revision: 1, status: 'ready' },
  ])
  legacy.close()
})
```

**`tests/linker.test.ts`**

```ts
test('a req to a missing requirement is unknown_req (bare and path forms)', () => {
  index('specs/coupon/spec.md', [
    '## C001 裸绑定悬空 <!-- oracle:manual req:FR999 -->',
    '## C002 跨文件悬空 <!-- oracle:manual req:specs/ghost/spec.md#FR001 -->',
  ].join('\n'))
  expect(linkWorkspace(db).map((e) => [e.code, e.clauseId])).toEqual([
    ['unknown_req', 'C001'],
    ['unknown_req', 'C002'],
  ])
})

test('a bare req resolves inside the feature unit, across files', () => {
  index('specs/coupon/reqs.md', '## FR001 意图')
  index('specs/coupon/spec.md', '## C001 锁 <!-- oracle:manual req:FR001 -->')
  index('specs/other/spec.md', '## C001 外部 <!-- oracle:manual req:FR001 -->')
  expect(linkWorkspace(db)).toEqual([
    expect.objectContaining({ code: 'unknown_req', specPath: 'specs/other/spec.md' }),
  ])
})

test('a changed FR stales every bound clause AND their ref dependents', () => {
  const reqSpec = (why: string) =>
    ['## FR001 意图', why, '## C001 锁 <!-- oracle:manual req:FR001 -->'].join('\n')
  index('specs/billing/spec.md', reqSpec('v1'))
  index('specs/coupon/spec.md',
    '## FR001 下游意图\n## C001 依赖 <!-- oracle:manual req:FR001 refs:specs/billing/spec.md#C001 -->')
  const changed = indexClauseFile(db, {
    specPath: 'specs/billing/spec.md', content: reqSpec('v2'), timestamp: 2,
  })
  expect(changed.kind === 'indexed' && changed.changedClauses).toEqual([])

  const report = propagateStale(db, [], 99, [{ specPath: 'specs/billing/spec.md', reqId: 'FR001' }])
  expect(report.staleClauses).toEqual([
    { specPath: 'specs/billing/spec.md', clauseId: 'C001' },
    { specPath: 'specs/coupon/spec.md', clauseId: 'C001' },
  ])
})

test('a duplicate FR id inside one unit fans out rather than picking a winner', () => {
  index('specs/x/a.md', '## FR001 甲')
  index('specs/x/b.md', '## FR001 乙')
  index('specs/x/spec.md', '## C001 锁 <!-- oracle:manual req:FR001 -->')
  expect(linkWorkspace(db)).toEqual([])
  expect(propagateStale(db, [], 99, [{ specPath: 'specs/x/b.md', reqId: 'FR001' }]).staleClauses).toEqual([
    { specPath: 'specs/x/spec.md', clauseId: 'C001' },
  ])
})

test('uncoveredRequirements lists live FRs with no live bound clause', () => {
  index('specs/x/spec.md', [
    '## FR001 有人守', '## FR002 没人守',
    '## C001 锁 <!-- oracle:manual req:FR001 -->',
  ].join('\n'))
  expect(uncoveredRequirements(db)).toEqual([
    { specPath: 'specs/x/spec.md', reqId: 'FR002', title: '没人守' },
  ])
})
```

**`tests/status.test.ts`**

```ts
test('an uncovered FR is reported beside the queue, never inside it', () => {
  const root = makeRepo([
    '## FR001 有人守', '## FR002 没人守',
    '## C001 label <!-- oracle:cmd:true req:FR001 -->',
  ])
  scanWorkspace(db, root)
  verifyWorkspace(db, root)
  agreeAll()
  const report = statusOf(root)
  expect(report.uncoveredRequirements).toEqual([
    { specPath: 'specs/x/spec.md', reqId: 'FR002', title: '没人守' },
  ])
  // Uncovered intent is not agent-fixable and never blocks: no item, no count.
  expect(report.items).toHaveLength(0)
  expect(report.counts).toEqual({ agent: 0, human: 0, autoPass: 1 })
  expect(report.wip.exceeded).toBe(false)
})
```

### 7.3 导出面（`src/index.ts` + `tests/package-surface.test.ts`）

新增导出：`type ClauseReq`、`type ParsedRequirement`（clause-parser）、
`uncoveredRequirements`、`type RequirementKey`、`type RequirementCoverage`（linker）。
`EXPECTED_EXPORTS` 同步补 `'uncoveredRequirements'`（类型不出现在
`Object.keys(urtext)` 里，只有值导出需要登记）。

### 7.4 不做的测试

不为"tasks.md 里的 FR 被忽略"写测试：那是在测一个非行为，
而它的真实失败面（`req:` 指向它）已被 `unknown_req` 覆盖。

---

## 8. Dogfood 迁移

### 8.1 落地顺序（不可分割）

`missing_requirement` 生效的那一刻，仓库全部 spec 立刻变 `building`。
因此 **src 改动 + 三个 spec 迁移 + 测试 fixture + SYNTAX.md 必须是同一个提交**，
不能拆 PR、不能 bisect。落地后按顺序验证：
`tsc --noEmit` → `vitest run` → `tsc -p` → `node dist/cli.js check` → `node dist/cli.js verify`
（即 `scripts/full-test.sh` 的既有序列）。

### 8.2 FR 放置规则（这条不遵守会炸）

FR 区块必须整体放在**第一条子句之前**。任何 heading 都会终止上一条子句的 body
（`ANY_HEADING`），把 FR 插在两条子句中间会截断前一条的 body →
`text_hash` 变 → 一次全仓 stale 风暴。

> **规划期实测**：`## 需求（FR）` 与 `## Requirements (FR)` 这两个区块标题
> 对两条正则都**不命中**（`REQUIREMENT_LINE` 要求 id 紧跟在 `#` 之后），
> 因此区块标题本身不会被误认成 FR 声明——区块标题可以安全使用。

### 8.3 `specs/urtext/spec.md` — FR 正文草案

插在文件头部说明段之后、`## C001` 之前：

```markdown
## 需求（FR）

本节是子句的上游意图：FR 说"为什么必须如此"，子句说"如何判定它成立"。
FR 是意图，不可判定——带 `oracle:` 或 `risk:` 的 FR 是索引期错误。

### FR001 规范性主张必须可判定

一条声称系统"必须如何"的陈述，若没有任何机械判定手段，就无法与愿望区分。
系统必须拒绝它进入执行体系，而不是把它降级为"较弱的真"。

### FR002 判定必须来自真实执行的证据

完成度必须是证据聚合，不是自述、不是评分。任何"通过"都必须能回指到一次
真实运行及其可复算的输出。

### FR003 事实账本必须不可改写

规范的历史本身是审计对象。索引只能追加，不能改写既有修订；删除只能追加墓碑。
没有不可改写的账本，就没有可信的回溯。

### FR004 引用必须完整，悬空即失败

跨文件引用与 checklist 对子句的引用一旦悬空，图就在说谎。校验必须发生在
全 workspace 快照上，而不是依赖引用方碰巧被重新索引。

### FR005 上游变更必须自动作废下游结论

上游条文文本一变，依赖它的结论就不再被证据支撑。系统必须自动把这些结论标记为
待重验，而不是依赖人记得去重跑。

### FR006 代码变更必须可归因到条文

事实源从代码翻转到规范，只有当每一处代码变更都能归因到某条子句、显式豁免或
规范回写时才成立。未归因的变更必须阻断合入。

### FR007 自动通过必须是最窄的路径

自动通过只覆盖"低风险 + 证据通过 + 异源审计同意 + 非 stale"这一条窄路；
其余一切情况都必须显式路由到人，并附可读原因。

### FR008 高危路径必须有绑定当下事实的人工签核

高危子句证据全绿也不足以放行：人必须看过当下的代码与上下文并签核；签核绑定
当时的 HEAD 与内容哈希，事实一变即失效。

### FR009 人的注意力必须收敛

人一次只应面对一个待办面和一个裁决上下文，而不是自行合并多条命令的输出。
注意力是最稀缺的资源，分散即漏判。

### FR010 系统对自身的描述不得漂移

文档与命令集、子句与实现必须同步演进。过期的文档是静默的谎言，
正是本系统要消除的东西。

### FR011 工程基线必须持续可编译

严格类型检查是其余一切保证的地基；地基红着的时候，别的保证都无从谈起。

### FR012 裁决上下文必须在图形界面完整可达

命令行之外，人必须能在界面上浏览全部活跃子句、区分各类 stale、并看到映射范围内
的真实代码 diff——否则"人做裁决"只是口号。

### FR013 意图与实现之间必须有机械可查的绑定

需求靠纪律对齐规范，就是本系统论证过必然失败的那种模式。每条规范性子句必须
声明它守的是哪条意图，每条意图必须能被查出有没有人守。
```

### 8.4 `specs/urtext/spec.md` — 逐条绑定（迁移后的 anchor 全文）

```markdown
## C001 无 oracle 的规范性子句被拒绝 <!-- oracle:test:tests/clause-parser.test.ts risk:high req:FR001 -->
## C002 checklist 引用未声明的子句被拒绝 <!-- oracle:test:tests/registry.test.ts risk:high req:FR004 -->
## C003 修订链不可变 <!-- oracle:test:tests/registry.test.ts req:FR003 -->
## C004 oracle 执行产出证据并驱动退出码 <!-- oracle:test:tests/verifier.test.ts risk:high req:FR002 -->
## C005 全仓类型检查通过 <!-- oracle:cmd:./scripts/oracle-typecheck.sh req:FR011 -->
## C006 CLI 帮助面命令集变更需人工确认 <!-- oracle:manual req:FR010 -->
## C007 悬空引用被拒绝 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C003 req:FR004 -->
## C008 上游文本变更传播 stale 并作废证据 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C004 req:FR005,FR002 -->
## C009 clause→code 映射由真实 diff 交叉验证 <!-- oracle:test:tests/dwarf.test.ts risk:high req:FR006 -->
## C010 unmapped change 被执法 <!-- oracle:test:tests/dwarf.test.ts risk:high refs:specs/urtext/spec.md#C009 req:FR006 -->
## C011 元验证只读证据且异源、分歧不静默 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C004 req:FR007 -->
## C012 风险分级裁决门 <!-- oracle:test:tests/gate.test.ts risk:high refs:specs/urtext/spec.md#C011 req:FR007 -->
## C013 unsafe lane：高危子句需绑定 HEAD 的人工代码审查 <!-- oracle:test:tests/review.test.ts risk:high refs:specs/urtext/spec.md#C012 req:FR008 -->
## C014 记忆层：manual 子句人工裁决落 Decision ledger <!-- oracle:test:tests/decision.test.ts risk:high refs:specs/urtext/spec.md#C012 req:FR008 -->
## C015 文档 wiki 命令参考覆盖真实命令集 <!-- oracle:cmd:scripts/oracle-wiki.sh%20command-coverage risk:low refs:specs/urtext/spec.md#C006 req:FR010 -->
## C016 status 双车道队列完整且 item 键控 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C012 req:FR009 -->
## C017 brief 单命令产出完整裁决上下文 <!-- oracle:test:tests/brief.test.ts refs:specs/urtext/spec.md#C009 req:FR009,FR008 -->
## C018 high-risk 批准的新鲜度与洁净前置 <!-- oracle:test:tests/brief-gate.test.ts risk:high refs:specs/urtext/spec.md#C013 req:FR008 -->
## C019 UI 完整呈现 Spec 影响与映射 Diff <!-- oracle:test:tests/spec-impact-interactions.test.ts risk:high refs:specs/urtext/spec.md#C017 req:FR012 -->
```

**除 anchor 外，19 条子句的标题与正文一字不动**——因此 `text_hash` 全部不变，
迁移不制造 stale（唯一的 stale 来源是 FR 首次出现，见 §8.5）。

### 8.5 新增子句：需求层自举（C020–C023）

`specs/loops/spec.md#C302` 要求"新增 oracle 类型 / 子句语法 / linker 边 / 检测路径
必须在同一 change 中同步增加多用例覆盖"。本特性同时新增了子句语法、
linker 边与检测路径，所以自举子句不是可选项：

```markdown
## C020 规范性子句必须绑定需求 <!-- oracle:test:tests/registry.test.ts risk:high refs:specs/urtext/spec.md#C001 req:FR013 -->

每条 `C\d+` 子句必须至少声明一条 `req:` 绑定，否则 `missing_requirement`
使修订停在 `building`——与 `missing_oracle` 对称：一条不知道自己在守什么意图的
规范锁，是作者的疏忽，不是一种较弱的真。FR 带 `oracle:`/`risk:` 同为索引期错误。

## C021 悬空需求绑定在 check 阶段被拒绝 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C007 req:FR013,FR004 -->

`req:` 在全 workspace 最新活跃修订上解析：裸 `FR\d+` 在同 feature 单元内解析，
`path#FR\d+` 精确解析。无法解析即 `unknown_req`，`urtext check` 退出码 1
（与 `unknown_ref` 同语义：目标被删/改名而绑定方文件未变同样被捕获）。

## C022 需求文本变更传播 stale 到绑定子句 <!-- oracle:test:tests/linker.test.ts risk:high refs:specs/urtext/spec.md#C008 req:FR005 -->

FR 的 text_hash（标题+正文）变更时，沿 `clause_reqs` 反向闭包标记全部绑定子句
stale，并继续沿 `clause_refs` 传播到它们的下游。FR 变更不铸出子句新修订，
所以绑定子句本身必须被打戳——否则意图已变而证据仍绿。

## C023 未覆盖需求在 status 中可见 <!-- oracle:test:tests/status.test.ts refs:specs/urtext/spec.md#C016 req:FR013,FR009 -->

`urtext status` 报告零活跃绑定子句的活跃 FR。未覆盖意图是人车道信息，
不是 agent 可修项：它不进队列、不计入 counts/wip、不改变退出码——
把它做成阻断项会惩罚"先写下意图再补锁"这一正当工作流。
```

`specs/urtext/tasks.md` 追加一行（沿用既有编号与格式）：

```markdown
- [ ] T016 需求层：FR 声明、req 绑定与覆盖报告 <!-- role:coder depends:T015 gate:true clauses:C020,C021,C022,C023 -->
    parser FR/req 与五个新错误码；requirements+clause_reqs 表；linker unknown_req 与 FR stale 闭包；status 未覆盖需求区块；三个 feature 的 FR 迁移。
```

### 8.6 `specs/distill/spec.md`（9 条子句）

FR 区块（英文，与该文件语言一致），插在首段之后、`## C001` 之前：

```markdown
## Requirements (FR)

Requirements state why this feature must exist; clauses state how each one is
mechanically defended. A requirement is intent and never decidable — an
`oracle:` or `risk:` field on one is an indexing error.

### FR001 Generated prose must never pass as human intent

Reverse-engineering a codebase produces plausible sentences. Unless observed
facts stay typed apart from inferences, a guess becomes an authoritative
behavioral guarantee the moment someone reads it.

### FR002 Observed facts must be deterministic and recomputable

A manifest that varies between runs cannot ground anything. Discovery must emit
a stable, sorted, HEAD-stamped artifact that a second run reproduces exactly.

### FR003 Declared evidence must resolve in the real repository

A specification pointing at files that do not exist is worse than no
specification: it reports coverage it does not have.

### FR004 Nothing reaches canonical specs without an explicit human act

Automation may stage candidates; only a human may make one canonical. Anything
inferred, manual, high-risk, or decision-bearing stays in staging.

### FR005 The command family must document its own output boundary

Every distill command must say, in help, what it writes and what it refuses to
write — otherwise "never modifies canonical specs" is an unverifiable promise.
```

绑定：

| 子句 | `req:` |
|---|---|
| C001 Discovery emits a versioned deterministic facts manifest | `FR002` |
| C002 Discovery distinguishes observed facts from declared links | `FR001` |
| C003 Coverage reports actionable declared-to-observed gaps | `FR003` |
| C004 Validation rejects non-existent declared evidence | `FR003` |
| C005 The CLI documents the distill command family | `FR005` |
| C006 Codebase-to-spec synthesis produces review-only candidates | `FR001,FR004` |
| C007 Fast promotion only imports observed low-risk runnable candidates | `FR004` |
| C008 Domain clustering inventories every observed file | `FR002` |
| C009 Observed baseline groups every executable test | `FR002` |

### 8.7 `specs/loops/spec.md`（25 条子句）

FR 区块用 `### FR00n`（与该文件 `### C101` 的层级一致），
插在引用块之后、`## 总则` 之前：

```markdown
## 需求（FR）

### FR001 裁判必须是运行结果，不是模型意见

任何"LLM 打分即通过"的路径都会把验证退化成互相恭维。判定权只能属于真实运行。

### FR002 并行产出在集成点之前一律视为未验证

worker 的自述不是证据。信任边界必须落在集成点，由集成者在新 trunk 上重验。

### FR003 事故必须变成规则，不能只修当次

只修当次问题、不回写规则，等于把同一个坑留给下一个夜班。

### FR004 loop 的意图必须来自单一事实源

在 prompt 里复述一份可能漂移的愿景摘要，是在制造第二份事实源。

### FR005 无人值守自动化不得制造不可逆破坏或全局停机

每个"等人类"的节点都是全局停机点，每条拼接出来的删除命令都是不可逆事故。

### FR006 攻击面与成本路由的边界由人类定义

扫哪里、用多贵的模型，是人的判断；AI 自撰边界等于自己给自己发考卷。

### FR007 findings 必须封闭分类、去重、可复现归档

开放分类会被风格与措辞噪音冲垮；不去重会被产出速度冲垮。

### FR008 审计必须只读、独立、可引用精确条文

审计一旦能改东西，它就不再是独立的第三方。

### FR009 改动不得越界，必须与 spec 归因对齐

worker 的每个 hunk 要么归因到子句，要么进 unmapped 由集成者裁决。

### FR010 成本必须与置信度匹配

便宜模型广撒网、强模型做验证，是让预算花在能提高置信度的地方。
```

绑定：

| 子句 | `req:` | 子句 | `req:` |
|---|---|---|---|
| C101 | `FR001` | C301 | `FR001` |
| C102 | `FR002` | C302 | `FR003` |
| C103 | `FR003` | C303 | `FR002` |
| C104 | `FR004` | C305 | `FR009` |
| C105 | `FR005` | C306 | `FR009` |
| C201 | `FR001` | C401 | `FR008` |
| C202 | `FR006` | C402 | `FR008` |
| C203 | `FR007` | C403 | `FR001,FR008` |
| C204 | `FR010` | C501 | `FR002` |
| C205 | `FR007` | C502 | `FR009` |
| C206 | `FR005` | C503 | `FR009` |
| C207 | `FR007` | C504 | `FR006` |
| C208 | `FR007` | | |

### 8.8 迁移的连带改动

- **`.claude/skills/codebase-to-spec/references/draft-template.md`**：
  clause 模板行改为
  `## C001 <decidable behavior> <!-- oracle:<kind>:<ref> risk:<low|high> req:FR<n> -->`，
  并把现有的 `- **<PREFIX>-FR-001**: <behavior>.` 散文条目升级为
  `## FR001 <intent>` 标题形式。
  **不改就会坏**：`missing_requirement` 生效后 `parseClauseFile` 对草稿报错，
  `src/distill.ts:616` 的 `throw new Error('draft contains invalid clause syntax')`
  会让 `urtext distill promote` 永远抛错。
  （这条 guard 本身不需要改代码——既有 fail-closed 正好覆盖了这个新失败面。）
- **`scripts/oracle-skill.sh`**：`codebase-to-spec` 分支追加一行
  `grep -q 'req:FR' "$template"`，让 C006 的 oracle 真的守住模板里的 req 绑定
  （loops#C302 的"覆盖随能力生长"）。
- **`docs/SYNTAX.md`**：见 §8.9。
- **`docs/wiki/` 与 `docs/zh-CN/wiki/`**：不新增命令 → `command-coverage`
  oracle（C015）不受影响，本次不动 wiki。

### 8.9 `docs/SYNTAX.md`（frozen-with-evolution-log）

四处改动：

1. 文件头 Status 引用块之后新增：

```markdown
## Version evolution

| Version | Change | Rationale |
|---|---|---|
| v0 | Initial frozen grammar | VISION P1/P6 |
| v0.1 | **Requirement layer**: `FR\d+` heading declarations, clause anchor field `req`, error codes `missing_requirement` / `malformed_req` / `duplicate_req_id` / `oracle_on_requirement` / `risk_on_requirement` / `unknown_req` | Clauses were regression locks with nothing grounding them upward; "which requirement has zero clauses" had no mechanical answer, and requirement→spec drift relied on discipline (the failure mode 05-source-of-truth-flip.md argues is structurally doomed) |
```

2. `## Clauses` 之后新增 `## Requirements (FR)` 一节，
   给出 heading 语法、"intent, not decidable"规则、unit-local vs `path#FR<n>` 解析、
   以及"FR 区块必须在第一条子句之前（heading 会截断上一条子句 body）"的作者提示。

3. Anchor fields 表加一行：

```markdown
| `req` | **yes** | comma-separated `FR<n>` or `path#FR<n>` | Requirements this clause defends. Omission is `missing_requirement` — symmetric with `missing_oracle`. Bare ids resolve inside the feature unit. |
```

4. Fail-closed errors 表加五行 + Registry 一节加两条 bullet：

```markdown
| `missing_requirement` | clause binds no requirement |
| `malformed_req` | a clause `req` value is not `FR<n>` or `<path>#FR<n>` |
| `duplicate_req_id` | a requirement ID repeats within a file |
| `oracle_on_requirement` | a requirement declaration carries an `oracle` |
| `risk_on_requirement` | a requirement declaration carries a `risk` |
| `unknown_req` | a clause `req` names a requirement no live file declares; validated during `check` |
```

```markdown
- Requirement declarations are stored in `requirements` on the SAME revision chain as the clauses of their file, each with `text_hash = sha256(heading + body)`.
- `req` edges are stored in `clause_reqs` (`to_spec = ''` marks a unit-local bare id) and resolved by the linker against all latest active revisions, exactly like `refs`. Changing a requirement `text_hash` stales every bound clause and, transitively, their `refs` dependents.
```

### 8.10 迁移后首次扫描的预期行为

首次 `urtext index` 时全部 FR 都是新增 → `changedRequirements` 覆盖全量 →
每条绑定子句被打 stale、既有证据全部 `invalidated_at`。
这与"rev 1 时全部子句都算 changed"的既有语义一致，**是预期的**：
需求层是新增的信息，它第一次绑上来时，此前的判定确实未曾在这条约束下做过。
落地流程因此以一次全量 `urtext verify` 收尾（`scripts/full-test.sh` 已包含）。

---

## 9. 风险与边界情况

| # | 情况 | 处理 | 备选与否决理由 |
|---|---|---|---|
| 1 | **FR-only 文件 / unit**（只有 FR、零子句） | 合法。`clauselessUnits` 警告照常出现，未覆盖报告同时列出全部 FR | 让 FR 抵消 clauseless 警告——会掩盖"这个 feature 一条可执行锁都没有"这个更重要的事实 |
| 2 | **FR 写在 tasks.md** | `parseTaskFile` 不认 heading，FR 不存在；指向它的 `req:` 得到 `unknown_req`（fail-closed） | 把 tasks.md 也按 clause 文件解析——会把 checklist 变成第二种子句文件，破坏 file_kind 二分 |
| 3 | **同文件重复 FR id** | `duplicate_req_id` 解析错误 → `building`；写库首个胜出，保 PK 不崩（与 duplicate_clause_id 同策） | 直接抛异常——一次坏编辑会让整个 index 崩掉，违反"可见但不可激活" |
| 4 | **同 unit 跨文件重复 FR id** | 裸绑定**扇出**到全部同名 FR：任一份文本变更都 stale，覆盖率上都算被守 | 报 `ambiguous_req` 或按路径字典序取首个——前者多一个错误码，后者让另一份 FR 的编辑静默不传播 stale（正是本系统要消灭的静默） |
| 5 | **跨 feature 引用 FR** | `req:specs/other/spec.md#FR001` 精确解析；owning 文件的修订驱动 stale | 禁止跨 feature——需求经常横跨多个 feature，禁掉等于逼人复制 FR |
| 6 | **FR 所在文件被删（tombstone）** | 绑定方 `unknown_req`、check 退出 1。但 `scanWorkspace` 从不调用 `tombstoneFile`（v0 既有缺口，`docs/wiki/mechanisms/02-registry.md` 已记录），所以删文件实际上让旧修订继续活着 | 本次顺手补 tombstone——是独立的 v0 缺口，塞进来会让本次 diff 不可评审 |
| 7 | **FR 插在两条子句之间** | 截断前一条子句 body → `text_hash` 变 → stale 风暴。§8.2 已把"FR 区块必须在首条子句之前"写成迁移硬规则 | 让 FR heading 不终止 clause body——会给 body 规则开一个按 id 前缀分叉的特例，语法从此不再统一 |
| 8 | **FR anchor 上的其他字段**（`refs:`、`req:`、未知键） | 静默忽略（与 clause anchor 的未知键同策） | allowlist——与既有 anchor 开放语义分叉 |
| 9 | **`req:` 写在非子句 heading 上** | 不是子句，整行不进系统 | 无 |
| 10 | **bootstrap**：实现与迁移必须同提交 | §8.1 写死落地顺序；不可 bisect | 加 feature flag 分两步——pinned contract 明确"NO config flag, NO warning mode" |
| 11 | **distill promote 产出无 `req:` 的子句** | 既有 fail-closed（`draft contains invalid clause syntax`）自动覆盖；模板与 skill oracle 同步更新（§8.8） | promote 时自动补一条占位 FR——凭空捏造意图，违反 distill 的全部立身之本 |
| 12 | **brief-hash 全量变化** | 每条子句变一次；review/decide 本来就绑 HEAD，迁移提交移动 HEAD，无有效批准被摧毁 | 不把 `reqs` 放进 manifest——`req:` 就成了永不出现在裁决上下文里的静默元数据 |
| 13 | **首扫全量 stale** | §8.10：预期行为，以一次全量 verify 收尾 | 首次索引跳过 FR stale——需要一个"这是第一次"的特例状态，注册表目前没有也不该有 |
| 14 | **`req:` 与 `refs:` 语法近似导致误写**（`req:specs/a/spec.md#C001`） | `malformed_req`（reqId 必须匹配 `FR\d+`） | 宽松接受 C-id——`req` 与 `refs` 的语义会当场坍缩 |

---

## Weaknesses I know about

对手会攻这些，我先自己说：

1. **改动被 fixture 噪音淹没。** 20 个测试文件 + 1 个脚本 fixture 必须逐个补
   FR/`req:`（§7.1 实测清单）。真正的契约改动可能不到 400 行，
   但 diff 会有上千行 fixture churn，评审者很难把两者分开。
   我没有找到能同时满足"fail-closed 无开关"和"fixture 零改动"的方案——
   这是 pinned contract 3 的直接代价，但代价确实很大。

2. **裸 `FR<n>` 扇出是个静默语义。** 同 unit 跨文件重复 FR id 时，
   一次绑定悄悄绑上两条 FR，没有任何输出告诉作者这件事发生了。
   我选了"过度传播优于漏传播"，但一个被扇出坑到的人不会觉得这很直观。

3. **`to_spec = ''` 是 schema 里的魔法值。** `NULL` 语义上更诚实，
   但会破坏 PK 去重与 `INSERT OR IGNORE`。我选了工程可用性，
   代价是任何直接读表的人都必须知道这个约定（只有列注释保护它）。

4. **覆盖率是建议性的，而 oracle 绑定是强制的。** 未覆盖 FR 永不阻断任何东西，
   于是一个仓库可以长期积累"没人守的意图"而门一直是绿的。
   这是 pinned contract 6 的要求，但它让需求层比子句层弱一档——
   "需求→子句"的漂移仍然靠人看报告，而这恰恰是本特性想根治的病。

5. **FR 上的禁止字段是枚举式否定，不是白名单。** 只挡 `oracle:` 和 `risk:`；
   将来任何一个新的可判定字段（比如 `severity:`）都要记得再补一条禁令，
   忘了就是静默通过。

6. **FR 放置位置由文档纪律保证，没有机械检查。** 把 FR 区块插在两条子句之间会
   截断前一条的 body 并引发 stale 风暴，而没有任何错误码提示。
   我考虑过"FR heading 不终止 clause body"，但那会让 body 规则出现按 id 分叉的特例。

7. **首次索引会作废全仓证据。** 迁移后必须跑一次全量 `urtext verify`；
   本仓 oracle 里有 `tsc --noEmit`（C005）和多个 `scripts/oracle-loops.sh` 检查，
   全量重跑不是零成本。在 oracle 更慢的仓库里，这个一次性代价会更疼。

8. **FR 方向的图是不可查询的。** 没有 `urtext impact <spec>#FR001`，
   人只能通过"未覆盖报告 + stale 副作用"间接观察需求层。
   我把它推迟了，但"哪些子句在守 FR007"是个非常自然的问题，现在答不了。

9. **需求层是扁平的。** 没有 FR→FR 层级、没有 FR 状态（draft/accepted/dropped）、
   没有 owner。一个 FR 一旦写下就与其他 FR 完全平权，
   真实产品的需求结构不长这样。

10. **`unknown_req` 的机器可读性弱于它该有的样子。** 它复用 `LinkError`，
    `clauseId` 是绑定方子句（语义正确），但"缺失的是哪条 FR"只存在于
    `message` 字符串里——`check --json` 的消费者要靠解析英文句子才能拿到 req id。
    我没有为此扩 `LinkError`，因为那会连带改 `unknown_ref` 的 envelope 形状。

11. **提交不可分割、不可 bisect。** src + 3 个 spec + 20 个测试文件 + SYNTAX.md +
    skill 模板必须一次落地。如果合入后 `urtext verify` 红了，
    回滚粒度就是整个特性，没有中间态可退。
