import { describe, expect, test } from 'vitest'

import { parseClauseFile } from '../src/clause-parser.js'

describe('parseClauseFile', () => {
  test('parses id, title, oracle, risk, and refs from the anchor', () => {
    const { clauses, errors } = parseClauseFile(
      [
        '## C001 优惠券不可叠加 <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:specs/billing/spec.md#C003 -->',
        'Given 已折扣商品 When 应用优惠券 Then 拒绝并返回 409',
      ].join('\n')
    )

    expect(errors).toEqual([])
    expect(clauses).toHaveLength(1)
    expect(clauses[0]).toMatchObject({
      clauseId: 'C001',
      seq: 1,
      title: '优惠券不可叠加',
      level: 2,
      oracle: { kind: 'test', ref: 'tests/coupon-stack.test.ts' },
      risk: 'high',
      refs: [{ path: 'specs/billing/spec.md', clauseId: 'C003' }],
      body: 'Given 已折扣商品 When 应用优惠券 Then 拒绝并返回 409',
    })
  })

  test('headings without a C-id are ordinary prose, not clauses', () => {
    const { clauses, errors } = parseClauseFile(
      ['# 概述', '', '这里是背景说明。', '', '## 设计目标', '- 快'].join('\n')
    )
    expect(clauses).toEqual([])
    expect(errors).toEqual([])
  })

  test('a clause without an oracle is a missing_oracle error (VISION P1)', () => {
    const { clauses, errors } = parseClauseFile('## C001 响应要快')
    expect(clauses).toHaveLength(1)
    expect(clauses[0]?.oracle).toBeNull()
    expect(errors).toEqual([
      expect.objectContaining({ code: 'missing_oracle', clauseId: 'C001', line: 0 }),
    ])
  })

  test('an unknown oracle kind is rejected', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:vibes:whatever -->')
    expect(errors).toEqual([
      expect.objectContaining({ code: 'invalid_oracle_kind', clauseId: 'C001' }),
    ])
  })

  test('manual oracle may omit the ref', () => {
    const { clauses, errors } = parseClauseFile('## C001 人工核对文案 <!-- oracle:manual -->')
    expect(errors).toEqual([])
    expect(clauses[0]?.oracle).toEqual({ kind: 'manual', ref: null })
  })

  test('cmd oracle keeps the full ref after the first colon', () => {
    const { clauses } = parseClauseFile('## C001 构建通过 <!-- oracle:cmd:npm:run:build -->')
    expect(clauses[0]?.oracle).toEqual({ kind: 'cmd', ref: 'npm:run:build' })
  })

  test('risk defaults to low; invalid risk is rejected', () => {
    const low = parseClauseFile('## C001 X <!-- oracle:manual -->')
    expect(low.clauses[0]?.risk).toBe('low')

    const bad = parseClauseFile('## C001 X <!-- oracle:manual risk:medium -->')
    expect(bad.errors).toEqual([expect.objectContaining({ code: 'invalid_risk' })])
  })

  test('a malformed ref is rejected', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:manual refs:no-hash-here -->')
    expect(errors).toEqual([expect.objectContaining({ code: 'malformed_ref', clauseId: 'C001' })])
  })

  test('duplicate clause ids are flagged', () => {
    const { errors } = parseClauseFile(
      ['## C001 First <!-- oracle:manual -->', '## C001 Second <!-- oracle:manual -->'].join('\n')
    )
    expect(errors).toEqual([
      expect.objectContaining({ code: 'duplicate_clause_id', clauseId: 'C001', line: 1 }),
    ])
  })

  test('body runs to the next heading of any level', () => {
    const { clauses } = parseClauseFile(
      [
        '## C001 First <!-- oracle:manual -->',
        'line one',
        'line two',
        '### 不是子句的小节',
        'other prose',
        '## C002 Second <!-- oracle:manual -->',
      ].join('\n')
    )
    expect(clauses).toHaveLength(2)
    expect(clauses[0]?.body).toBe('line one\nline two')
    expect(clauses[1]?.body).toBeNull()
  })

  test('multiple refs are comma-separated', () => {
    const { clauses, errors } = parseClauseFile(
      '## C001 X <!-- oracle:manual refs:specs/a/spec.md#C001,specs/b/spec.md#C002 -->'
    )
    expect(errors).toEqual([])
    expect(clauses[0]?.refs).toEqual([
      { path: 'specs/a/spec.md', clauseId: 'C001' },
      { path: 'specs/b/spec.md', clauseId: 'C002' },
    ])
  })

  test('a malformed anchor token is surfaced with the clause id', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:manual junktoken -->')
    expect(errors).toEqual([expect.objectContaining({ code: 'malformed_anchor', clauseId: 'C001' })])
  })
})
