import { describe, expect, test } from 'vitest'

import { parseTaskFile, serializeTaskFile, type ParsedTask } from '../src/task-parser.js'

describe('parseTaskFile', () => {
  test('parses id, title, and anchor metadata including multi-clause refs', () => {
    const { tasks, errors } = parseTaskFile(
      [
        '- [ ] T000 Prereq <!-- role:coder -->',
        '- [ ] T001 Set up schema <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->',
      ].join('\n')
    )

    expect(errors).toEqual([])
    expect(tasks).toHaveLength(2)
    expect(tasks[1]).toMatchObject({
      fileId: 'T001',
      seq: 2,
      title: 'Set up schema',
      checked: false,
      dependsOn: ['T000'],
      role: 'coder',
      humanGate: true,
      clauses: ['C001', 'C002'],
      prompt: null,
    })
  })

  test('captures the indented prompt block beneath a task line', () => {
    const { tasks } = parseTaskFile(
      [
        '- [ ] T001 Build the widget <!-- role:coder -->',
        '    Implement the schema.',
        '    Add a migration.',
        '- [ ] T002 Test the widget <!-- role:tester depends:T001 -->',
      ].join('\n')
    )

    expect(tasks[0]?.prompt).toBe('Implement the schema.\nAdd a migration.')
    expect(tasks[1]?.prompt).toBeNull()
  })

  test('flags a checkbox line missing a T00x id (coverage gap, not silent drop)', () => {
    const { tasks, errors } = parseTaskFile('- [ ] A task with no id')
    expect(tasks).toEqual([])
    expect(errors).toEqual([expect.objectContaining({ code: 'missing_file_id', line: 0 })])
  })

  test('flags duplicate ids, self deps, and unknown deps (fail-closed)', () => {
    const dup = parseTaskFile(['- [ ] T001 First', '- [ ] T001 Second'].join('\n'))
    expect(dup.errors).toEqual([expect.objectContaining({ code: 'duplicate_file_id' })])

    const self = parseTaskFile('- [ ] T001 Task <!-- depends:T001 -->')
    expect(self.errors).toEqual([expect.objectContaining({ code: 'self_dependency' })])

    const unknown = parseTaskFile('- [ ] T001 Task <!-- depends:T999 -->')
    expect(unknown.errors).toEqual([expect.objectContaining({ code: 'unknown_dependency' })])
  })

  test('flags a clause ref that is not a C-id', () => {
    const { errors } = parseTaskFile('- [ ] T001 Task <!-- clauses:X9 -->')
    expect(errors).toEqual([
      expect.objectContaining({ code: 'malformed_clause_ref', fileId: 'T001' }),
    ])
  })

  test('round-trips through serializeTaskFile', () => {
    const source = [
      '- [ ] T001 Root <!-- role:coder gate:true clauses:C001 -->',
      '    Do the thing.',
      '- [x] T002 Leaf <!-- role:tester depends:T001 clauses:C001,C002 -->',
    ].join('\n')
    const { tasks, errors } = parseTaskFile(source)
    expect(errors).toEqual([])

    const reparsed = parseTaskFile(serializeTaskFile(tasks))
    expect(reparsed.errors).toEqual([])
    const strip = (task: ParsedTask) => ({ ...task, line: 0 })
    expect(reparsed.tasks.map(strip)).toEqual(tasks.map(strip))
  })
})
