import { describe, expect, test, vi } from 'vitest'

// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { makeRealRuntime, makeStubRuntime, resolveAdapters } from '../.claude/workflows/lib/adapters.mjs'
// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { run as runAudit } from '../.claude/workflows/lib/audit-core.mjs'
// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { run as runFix } from '../.claude/workflows/lib/fix-core.mjs'
// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { run as runHunt } from '../.claude/workflows/lib/hunt-core.mjs'

const FIX_INPUT = JSON.stringify({
  cycle: 7,
  clusters: [{ key: 'parser', prompt: 'Fix parser issue', issues: [42] }],
})

const makeHarness = () => {
  const files = new Map([['.claude/workflows/hunt-ledger.json', '{"swept":{}}'], ['.claude/workflows/fix-cycle-input.json', FIX_INPUT]])
  const shellCalls: string[] = []
  const shell = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((result, part, index) => result + part + (index < values.length ? String(values[index]) : ''), '')
    shellCalls.push(command)
    return {
      async text() {
        if (command.includes('git rev-parse HEAD')) return 'base-sha\n'
        if (command.includes('gh issue list')) return '[]'
        return ''
      },
    }
  }
  const agent = vi.fn(async (_prompt: string, opts: { schema?: { properties?: Record<string, unknown> } }) => {
    if (opts.schema?.properties?.key) {
      return { key: 'parser', fixed: [], refuted: [], tests_added: [], full_suite_green: true }
    }
    return { findings: [] }
  })
  const writes: Array<[string, string]> = []
  const globals = {
    read: vi.fn((path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`missing fixture: ${path}`)
      return content
    }),
    write: vi.fn((path: string, content: string) => {
      writes.push([path, content])
      files.set(path, content)
    }),
    log: vi.fn(),
    parallel: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((task) => task())),
    agent,
    Bun: { $: shell },
  }
  return { globals, agent, shellCalls, writes }
}

const runAll = async (runtime: Parameters<typeof runHunt>[0]) => {
  await runHunt(runtime)
  await runFix(runtime)
  await runAudit(runtime)
}

describe('loop runtime seams', () => {
  test('binds the complete runtime and adapter shape', () => {
    const stub = makeStubRuntime()
    for (const field of ['read', 'write', 'log', 'parallel', 'env', 'adapters']) {
      expect(stub[field]).not.toBeUndefined()
    }
    for (const adapter of ['agent', 'gh', 'worktree']) {
      expect(stub.adapters[adapter]).not.toBeUndefined()
    }

    const { globals } = makeHarness()
    const real = makeRealRuntime(globals, {})
    expect(real.adapters.agent.kind).toBe('real')
    expect(real.adapters.gh.kind).toBe('real')
    expect(real.adapters.worktree.kind).toBe('real')
    expect(resolveAdapters({ DRY_RUN: '1' }).worktree.kind).toBe('stub')
  })

  test('production mainlines consume real adapters through an intercepted harness', async () => {
    const { globals, agent, shellCalls } = makeHarness()
    await runAll(makeRealRuntime(globals, {}))

    expect(agent).toHaveBeenCalled()
    expect(shellCalls.some((command) => command.includes('gh issue list'))).toBe(true)
    expect(shellCalls).toContain('git rev-parse HEAD')
    expect(shellCalls).toContain('git worktree add /tmp/urtext-fix/cycle-7/wt-parser base-sha')
  })

  test('DRY_RUN mainlines consume stubs without reaching harness side effects', async () => {
    const { globals, agent, shellCalls } = makeHarness()
    const runtime = makeRealRuntime(globals, { DRY_RUN: '1' })
    await runAll(runtime)

    expect(agent).not.toHaveBeenCalled()
    expect(shellCalls).toEqual([])
    expect(runtime.adapters.agent.calls.length).toBeGreaterThan(0)
    expect(runtime.adapters.gh.calls.list.length).toBeGreaterThan(0)
    expect(runtime.adapters.worktree.calls).toEqual([
      { method: 'head' },
      { method: 'add', path: '/tmp/urtext-fix/cycle-7/wt-parser', base: 'stub-head' },
    ])
  })

  test('fix core calls an injected worktree spy with path and base', async () => {
    const { globals } = makeHarness()
    const worktree = {
      kind: 'stub',
      head: vi.fn(async () => 'spy-base'),
      add: vi.fn(async () => undefined),
    }
    const runtime = makeRealRuntime(globals, { DRY_RUN: '1' })
    runtime.adapters.worktree = worktree

    await runFix(runtime)

    expect(worktree.head).toHaveBeenCalledOnce()
    expect(worktree.add).toHaveBeenCalledWith('/tmp/urtext-fix/cycle-7/wt-parser', 'spy-base')
  })
})
