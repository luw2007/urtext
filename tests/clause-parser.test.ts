import { describe, expect, test } from 'vitest'

import { parseClauseFile } from '../src/clause-parser.js'

describe('parseClauseFile', () => {
  test('parses requirements and clause req bindings in one ordered pass', () => {
    const parsed = parseClauseFile(
      [
        '## FR001 人必须看得见未覆盖的意图',
        '为什么需要这条。',
        '## C001 X <!-- oracle:manual req:FR001,specs/b/spec.md#FR002,FR001, -->',
      ].join('\n')
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.requirements).toEqual([
      {
        reqId: 'FR001',
        seq: 1,
        title: '人必须看得见未覆盖的意图',
        level: 2,
        body: '为什么需要这条。',
        line: 0,
      },
    ])
    expect(parsed.clauses[0]?.reqs).toEqual([
      { path: null, reqId: 'FR001' },
      { path: 'specs/b/spec.md', reqId: 'FR002' },
    ])
  })

  test('missing, empty, and malformed req values have distinct single errors', () => {
    expect(parseClauseFile('## C001 X <!-- oracle:manual -->').errors).toEqual([
      expect.objectContaining({ code: 'missing_requirement', clauseId: 'C001' }),
    ])
    for (const anchor of ['req:', 'req:,,', 'req:C001', 'req:#FR001', 'req:FR']) {
      expect(parseClauseFile(`## C001 X <!-- oracle:manual ${anchor} -->`).errors).toEqual([
        expect.objectContaining({ code: 'malformed_req', clauseId: 'C001' }),
      ])
    }
    expect(parseClauseFile('## C001 X <!-- oracle:manual req:FR001, -->').errors).toEqual([])
  })

  test('requirement-only fields and duplicate ids fail closed', () => {
    expect(parseClauseFile('## FR001 X <!-- oracle:manual -->').errors).toEqual([
      expect.objectContaining({ code: 'oracle_on_requirement', reqId: 'FR001' }),
    ])
    expect(parseClauseFile('## FR001 X <!-- risk:high -->').errors).toEqual([
      expect.objectContaining({ code: 'risk_on_requirement', reqId: 'FR001' }),
    ])
    expect(parseClauseFile('## FR001 A\n## FR001 B').errors).toEqual([
      expect.objectContaining({ code: 'duplicate_req_id', reqId: 'FR001', line: 1 }),
    ])
  })

  test('FR headings may appear anywhere and terminate the previous body like any heading', () => {
    const parsed = parseClauseFile(
      [
        '## C001 First <!-- oracle:manual req:FR001 -->',
        'clause body',
        '### FR001 Later intent',
        'intent body',
      ].join('\n')
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.clauses[0]?.body).toBe('clause body')
    expect(parsed.requirements[0]?.body).toBe('intent body')
  })

  test('parses id, title, oracle, risk, and refs from the anchor', () => {
    const { clauses, errors } = parseClauseFile(
      [
        '## C001 优惠券不可叠加 <!-- oracle:test:tests/coupon-stack.test.ts risk:high refs:specs/billing/spec.md#C003 req:FR001 -->',
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
    const { clauses, errors } = parseClauseFile('## C001 响应要快 <!-- req:FR001 -->')
    expect(clauses).toHaveLength(1)
    expect(clauses[0]?.oracle).toBeNull()
    expect(errors).toEqual([
      expect.objectContaining({ code: 'missing_oracle', clauseId: 'C001', line: 0 }),
    ])
  })

  test('an unknown oracle kind is rejected', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:vibes:whatever req:FR001 -->')
    expect(errors).toEqual([
      expect.objectContaining({ code: 'invalid_oracle_kind', clauseId: 'C001' }),
    ])
  })

  test('manual oracle may omit the ref', () => {
    const { clauses, errors } = parseClauseFile('## C001 人工核对文案 <!-- oracle:manual req:FR001 -->')
    expect(errors).toEqual([])
    expect(clauses[0]?.oracle).toEqual({ kind: 'manual', ref: null })
  })

  test('cmd oracle keeps the full ref after the first colon', () => {
    const { clauses } = parseClauseFile('## C001 构建通过 <!-- oracle:cmd:npm:run:build req:FR001 -->')
    expect(clauses[0]?.oracle).toEqual({ kind: 'cmd', ref: 'npm:run:build' })
  })

  test('risk defaults to low; invalid risk is rejected', () => {
    const low = parseClauseFile('## C001 X <!-- oracle:manual req:FR001 -->')
    expect(low.clauses[0]?.risk).toBe('low')

    const bad = parseClauseFile('## C001 X <!-- oracle:manual risk:medium req:FR001 -->')
    expect(bad.errors).toEqual([expect.objectContaining({ code: 'invalid_risk' })])
  })

  test('a malformed ref is rejected', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:manual refs:no-hash-here req:FR001 -->')
    expect(errors).toEqual([expect.objectContaining({ code: 'malformed_ref', clauseId: 'C001' })])
  })

  test('duplicate clause ids are flagged', () => {
    const { errors } = parseClauseFile(
      ['## C001 First <!-- oracle:manual req:FR001 -->', '## C001 Second <!-- oracle:manual req:FR001 -->'].join('\n')
    )
    expect(errors).toEqual([
      expect.objectContaining({ code: 'duplicate_clause_id', clauseId: 'C001', line: 1 }),
    ])
  })

  test('body runs to the next heading of any level', () => {
    const { clauses } = parseClauseFile(
      [
        '## C001 First <!-- oracle:manual req:FR001 -->',
        'line one',
        'line two',
        '### 不是子句的小节',
        'other prose',
        '## C002 Second <!-- oracle:manual req:FR001 -->',
      ].join('\n')
    )
    expect(clauses).toHaveLength(2)
    expect(clauses[0]?.body).toBe('line one\nline two')
    expect(clauses[1]?.body).toBeNull()
  })

  test('multiple refs are comma-separated', () => {
    const { clauses, errors } = parseClauseFile(
      '## C001 X <!-- oracle:manual refs:specs/a/spec.md#C001,specs/b/spec.md#C002 req:FR001 -->'
    )
    expect(errors).toEqual([])
    expect(clauses[0]?.refs).toEqual([
      { path: 'specs/a/spec.md', clauseId: 'C001' },
      { path: 'specs/b/spec.md', clauseId: 'C002' },
    ])
  })

  test('a malformed anchor token is surfaced with the clause id', () => {
    const { errors } = parseClauseFile('## C001 X <!-- oracle:manual junktoken req:FR001 -->')
    expect(errors).toEqual([expect.objectContaining({ code: 'malformed_anchor', clauseId: 'C001' })])
  })
})
