/**
 * Parser for `specs/<feature>/tasks.md` — the acceptance checklist. Tasks
 * reference the clause ids declared in the same feature unit via the
 * multi-value `clauses:` anchor field.
 *
 * Line grammar (one task per checkbox line; prompt is the indented prose that
 * follows, up to the next task line):
 *
 *   - [ ] T001 实现叠加校验 <!-- role:coder depends:T000 gate:true clauses:C001,C002 -->
 *       在 apply 路径上拒绝已折扣商品。
 *
 * Fail-closed: a malformed file yields `errors` and the revision stays at
 * `building`, never activatable.
 */

import { parseAnchorFields, type AnchorParseIssue } from './anchor.js'

export interface ParsedTask {
  /** Stable in-file id, e.g. `T001`. Unique within the file. */
  fileId: string
  /** 1-based order of appearance. */
  seq: number
  title: string
  checked: boolean
  /** In-file ids this task depends on (validated to resolve within the file). */
  dependsOn: string[]
  /** Worker role the task dispatches to; null when the author omitted it. */
  role: string | null
  /** Whether the task requires a human gate before it is considered done. */
  humanGate: boolean
  /** Clause ids this task claims to satisfy (e.g. `["C001", "C002"]`). */
  clauses: string[]
  /** Indented prose beneath the task line, joined by `\n`; null when absent. */
  prompt: string | null
  /** 0-based line index of the task's checkbox line, for error anchoring. */
  line: number
}

export interface TaskParseError {
  code:
    | 'missing_file_id'
    | 'duplicate_file_id'
    | 'self_dependency'
    | 'unknown_dependency'
    | 'malformed_anchor'
    | 'malformed_clause_ref'
  fileId?: string
  line: number
  message: string
}

export interface ParsedTaskFile {
  tasks: ParsedTask[]
  errors: TaskParseError[]
}

// `- [ ] T001 Title …` — capture indent, mark, file id, and the rest of the line.
const TASK_LINE = /^(\s*)-\s+\[( |x|X)\]\s+(T\d+)\b\s*(.*)$/
// Any checkbox line, used to detect where a task's prompt block ends.
const ANY_TASK_LINE = /^\s*-\s+\[( |x|X)\]\s+/
const ANCHOR = /<!--\s*(.*?)\s*-->/
// A `- [ ] Foo` line with NO `T00x` id — an authoring mistake we must surface,
// not silently drop, so coverage gaps are visible at review.
const CHECKBOX_WITHOUT_ID = /^\s*-\s+\[( |x|X)\]\s+(?!T\d+\b)/

const parseList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

export const parseTaskFile = (content: string): ParsedTaskFile => {
  const lines = content.split(/\r?\n/)
  const tasks: ParsedTask[] = []
  const errors: TaskParseError[] = []
  const seenFileIds = new Set<string>()
  let seq = 0

  // First pass: extract each task line + its indented prompt block.
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (rawLine === undefined) continue

    const match = rawLine.match(TASK_LINE)
    if (!match) {
      if (CHECKBOX_WITHOUT_ID.test(rawLine)) {
        errors.push({
          code: 'missing_file_id',
          line: i,
          message: `Checkbox task at line ${i + 1} is missing a "T00x" id.`,
        })
      }
      continue
    }

    const [, indentRaw = '', mark = ' ', fileId = '', rest = ''] = match
    const indent = indentRaw.replace(/\t/g, '  ').length

    const anchorMatch = rest.match(ANCHOR)
    let fields: Record<string, string> = {}
    if (anchorMatch?.[1] !== undefined) {
      const parsed = parseAnchorFields(anchorMatch[1])
      fields = parsed.fields
      for (const issue of parsed.issues) errors.push(toAnchorError(issue, i, fileId))
    }
    const title = rest.replace(ANCHOR, '').replace(/\s+/g, ' ').trim()

    const clauses = parseList(fields.clauses)
    for (const clauseId of clauses) {
      if (!/^C\d+$/.test(clauseId)) {
        errors.push({
          code: 'malformed_clause_ref',
          fileId,
          line: i,
          message: `Task "${fileId}" clause ref "${clauseId}" is not a "C<n>" id.`,
        })
      }
    }

    // Prompt = subsequent lines indented deeper than the task line, until the
    // next checkbox task line (any depth) or a shallower non-task line.
    const promptLines: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const probe = lines[j]
      if (probe === undefined) break
      if (ANY_TASK_LINE.test(probe)) break
      if (probe.trim().length === 0) {
        promptLines.push('')
        continue
      }
      const probeIndent = probe.replace(/\t/g, '  ').match(/^ */)?.[0].length ?? 0
      if (probeIndent <= indent) break
      promptLines.push(probe.trim())
    }
    const prompt = promptLines.join('\n').trim() || null

    if (seenFileIds.has(fileId)) {
      errors.push({
        code: 'duplicate_file_id',
        fileId,
        line: i,
        message: `Task id "${fileId}" is declared more than once.`,
      })
    }
    seenFileIds.add(fileId)

    tasks.push({
      fileId,
      seq: ++seq,
      title,
      checked: mark.toLowerCase() === 'x',
      dependsOn: parseList(fields.depends),
      role: fields.role ?? null,
      humanGate: fields.gate === 'true',
      clauses,
      prompt,
      line: i,
    })
  }

  // Second pass: dependency closure (must resolve within the file, no self-dep).
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.fileId) {
        errors.push({
          code: 'self_dependency',
          fileId: task.fileId,
          line: task.line,
          message: `Task "${task.fileId}" cannot depend on itself.`,
        })
      } else if (!seenFileIds.has(dependencyId)) {
        errors.push({
          code: 'unknown_dependency',
          fileId: task.fileId,
          line: task.line,
          message: `Task "${task.fileId}" depends on unknown task "${dependencyId}".`,
        })
      }
    }
  }

  return { tasks, errors }
}

/**
 * Serialize tasks back to `tasks.md`. Inverse of `parseTaskFile` for the
 * fields it round-trips. Used by tooling that edits checklists
 * programmatically; hand-authored files stay the authority.
 */
export const serializeTaskFile = (tasks: ParsedTask[]): string => {
  const blocks: string[] = []
  for (const task of tasks) {
    const anchorParts: string[] = []
    if (task.role) anchorParts.push(`role:${task.role}`)
    if (task.dependsOn.length > 0) anchorParts.push(`depends:${task.dependsOn.join(',')}`)
    if (task.humanGate) anchorParts.push('gate:true')
    if (task.clauses.length > 0) anchorParts.push(`clauses:${task.clauses.join(',')}`)
    const anchor = anchorParts.length > 0 ? ` <!-- ${anchorParts.join(' ')} -->` : ''
    const checkbox = task.checked ? '[x]' : '[ ]'
    let block = `- ${checkbox} ${task.fileId} ${task.title}${anchor}`
    if (task.prompt) {
      const indented = task.prompt
        .split('\n')
        .map((promptLine) => (promptLine ? `    ${promptLine}` : ''))
        .join('\n')
      block += `\n${indented}`
    }
    blocks.push(block)
  }
  return `${blocks.join('\n')}\n`
}

const toAnchorError = (issue: AnchorParseIssue, line: number, fileId: string): TaskParseError => ({
  code: 'malformed_anchor',
  fileId,
  line,
  message: `Task "${fileId}": ${issue.message}`,
})
