import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { parseClauseFile } from '../src/clause-parser.js'
import type { UiSnapshot } from '../src/review-ui.js'
import { renderConsoleFamilyPage } from '../src/ui/render-console.js'
import { parseTaskFile } from '../src/task-parser.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const projectionSnapshot = (): UiSnapshot => ({
  head: 'abcdef0123456789',
  dirty: false,
  status: {
    schema: 'urtext.status/1',
    head: 'abcdef0123456789',
    items: [
      {
        key: 'src/unmapped.ts:1-1',
        kind: 'unmapped',
        lane: 'human',
        primary: 'unmapped',
        reasons: ['unmapped'],
        next: 'map or acknowledge the hunk',
        filePath: 'src/unmapped.ts',
        lineStart: 1,
        lineEnd: 1,
      },
      {
        key: 'specs/demo/spec.md#C003',
        kind: 'clause',
        lane: 'human',
        primary: 'manual_undecided',
        reasons: ['manual_undecided'],
        next: 'decide this manual clause',
        specPath: 'specs/demo/spec.md',
        clauseId: 'C003',
        title: 'Human decision',
        risk: 'low',
      },
      {
        key: 'specs/demo/spec.md#C002',
        kind: 'clause',
        lane: 'agent',
        primary: 'stale',
        reasons: ['stale'],
        next: 're-run verify',
        specPath: 'specs/demo/spec.md',
        clauseId: 'C002',
        title: 'Dependent clause',
        risk: 'low',
        invalidationSource: 'specs/demo/spec.md#C001',
      },
    ],
    counts: { agent: 1, human: 2, uncovered: 0, autoPass: 0 },
    wip: { limit: 10, exceeded: false },
    uncoveredRequirements: [],
  },
  clauses: [
    {
      specPath: 'specs/demo/spec.md',
      clauseId: 'C003',
      title: 'Human decision',
      risk: 'low',
      decisionVerdict: 'none',
      evidenceVerdict: 'pending',
      auditVerdict: 'unaudited',
      reviewStatus: 'n/a',
      stale: false,
      actionable: true,
    },
  ],
  decided: 0,
  totalManual: 1,
  unmapped: [{ filePath: 'src/unmapped.ts', lineStart: 1, lineEnd: 1 }],
  unmappedError: null,
})

describe('C028 UI human-projection oracle', () => {
  test('pins the ratified C028/T019 contract without reusing C027/T018', () => {
    const clauses = parseClauseFile(readFileSync(join(ROOT, 'specs/urtext/spec.md'), 'utf8'))
    const c028 = clauses.clauses.find((clause) => clause.clauseId === 'C028')
    expect(c028).toMatchObject({
      oracle: { kind: 'test', ref: 'tests/ui-projection.test.ts' },
      risk: 'high',
      refs: [
        { path: 'specs/urtext/spec.md', clauseId: 'C008' },
        { path: 'specs/urtext/spec.md', clauseId: 'C016' },
        { path: 'specs/urtext/spec.md', clauseId: 'C019' },
        { path: 'specs/urtext/spec.md', clauseId: 'C026' },
      ],
      reqs: [{ path: null, reqId: 'FR009' }, { path: null, reqId: 'FR012' }],
    })
    const c008 = clauses.clauses.find((clause) => clause.clauseId === 'C008')
    expect(c008?.body).toBe([
      '子句 text_hash（标题+正文）变更时，沿 `clause_refs` 反向闭包标记依赖子句 stale，',
      '其既有证据的作废戳（`invalidated_at` + `invalidation_source`）在同一事件中写入——证据唯一可变面，作废不删除（审计保留）。',
    ].join('\n'))
    expect(c028?.body).toBe([
      '`urtext ui` 必须把七维裁决状态投影成人可直接判读的低维视图，且全部为渲染投影：',
      '不产生第二事实源，不进入 items、counts、WIP 或退出码。',
      '',
      '每条 stale 队列项渲染一句因果链——上游变更 key → 本条证据作废 → 重跑 verify 前不放行；',
      '来源取自与 `invalidated_at` 同一次写入的 `invalidation_source`（一枚印章两列），',
      'FR 直接命中的子句归因到该 FR 而非它自身，历史 NULL 行渲染无来源版本，绝不伪造来源。',
      'Your queue 按 feature 单元渲染证据/元审计/高危批准/未覆盖意图的只读健康行。',
      'clause detail 渲染 defended FR ← 本条 → refs 目标 → 直接依赖的一跳邻域（一跳，非闭包）。',
      'approve/decide 控件旁常驻绑定 HEAD 短 sha 与失效规则的静态说明。',
      'AI 解释对每个人车道条款项、unmapped 项与每个成功 clause detail 可用，只读、fail-closed，',
      '其文本永不进入任何账本（R4 红线）。',
    ].join('\n'))

    const tasks = parseTaskFile(readFileSync(join(ROOT, 'specs/urtext/tasks.md'), 'utf8'))
    expect(tasks.errors).toEqual([])
    expect(tasks.tasks.find((task) => task.fileId === 'T019')).toMatchObject({
      dependsOn: ['T018'],
      clauses: ['C028'],
      humanGate: true,
    })
  })

  test('renders C028 queue projections as derived UI only', () => {
    const snapshot = projectionSnapshot()
    const queue = renderConsoleFamilyPage({
      route: 'queue',
      snapshot,
      csrfToken: 'csrf',
      page: 1,
      pageSize: 20,
    })
    const agent = renderConsoleFamilyPage({
      route: 'agent',
      snapshot,
      csrfToken: 'csrf',
      page: 1,
      pageSize: 20,
    })

    expect(queue).toContain('<ul id="feature-health"')
    expect(queue.indexOf('data-banner="unmapped"')).toBeLessThan(queue.indexOf('id="feature-health"'))
    expect(queue.indexOf('id="feature-health"')).toBeLessThan(queue.indexOf('id="your-queue-rows"'))
    expect(queue).toContain('id="queue-explain-btn"')
    expect(queue).toContain('id="explain-item-btn-0"')
    expect(queue).toContain('aria-controls="explain-item-out-0"')
    expect(queue).toContain('id="explain-item-btn-1"')
    expect(queue).toContain('aria-controls="explain-item-out-1"')
    expect(queue).toContain('本次批准绑定 HEAD abcdef0；代码再动自动失效，需重审。')
    expect(agent).toContain('specs/demo/spec.md#C001</code> 文本变更 → <code>specs/demo/spec.md#C002</code> 证据作废 → 重跑 <code>urtext verify</code> 前不放行')
    expect(agent).not.toContain('data-explain-key=')
  })
})
