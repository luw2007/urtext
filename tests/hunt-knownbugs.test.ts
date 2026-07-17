import { describe, expect, test, vi } from 'vitest'

// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { makeRealRuntime, makeStubRuntime } from '../.claude/workflows/lib/adapters.mjs'
// @ts-expect-error The workflow runtime is intentionally plain ESM outside src/.
import { run } from '../.claude/workflows/lib/hunt-core.mjs'

const LEDGER_PATH = '.claude/workflows/hunt-ledger.json'

const makeRuntime = (overrides: Record<string, unknown> = {}) => {
  const writes: Array<[string, string]> = []
  const runtime = {
    read: vi.fn(() => '{"swept":{}}'),
    write: vi.fn((path: string, content: string) => {
      writes.push([path, content])
    }),
    log: vi.fn(),
    parallel: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((task) => task())),
    env: {},
    adapters: {
      agent: vi.fn(async () => ({ findings: [] })),
      gh: {
        list: vi.fn(async () => []),
        create: vi.fn(async () => undefined),
      },
    },
    ...overrides,
  }
  return { runtime, writes }
}

describe('hunt known-bug GitHub round-trip', () => {
  test('exports callable real and stub runtime factories', () => {
    expect(makeStubRuntime()).toMatchObject({ env: { DRY_RUN: '1' } })
    expect(makeRealRuntime({}, { DRY_RUN: '1' })).toHaveProperty('adapters.gh.kind', 'stub')
  })

  test('fails fast when loading GitHub issues fails and does not update the ledger', async () => {
    const { runtime, writes } = makeRuntime()
    runtime.adapters.gh.list.mockRejectedValueOnce(new Error('gh unavailable'))

    await expect(run(runtime)).rejects.toThrow('gh unavailable')
    expect(writes).toEqual([])
    expect(runtime.write).not.toHaveBeenCalledWith(LEDGER_PATH, expect.anything())
    expect(runtime.adapters.agent).not.toHaveBeenCalled()
  })

  test('injects only issues carrying the current area label', async () => {
    const prompts: string[] = []
    const { runtime } = makeRuntime()
    runtime.adapters.gh.list.mockResolvedValueOnce([
      { number: 1, title: 'matching known bug', labels: [{ name: 'area:clause-parser' }] },
      { number: 2, title: 'different area bug', labels: [{ name: 'area:linker' }] },
      { number: 3, title: 'unlabelled bug', labels: [{ name: 'hunt' }] },
    ])
    runtime.adapters.agent.mockImplementation(async (prompt: string) => {
      prompts.push(prompt)
      return { findings: [] }
    })

    await run(runtime)

    expect(prompts).toHaveLength(4)
    for (const prompt of prompts) {
      expect(prompt).toContain('Known bugs — do NOT re-report: matching known bug')
      expect(prompt).not.toContain('different area bug')
      expect(prompt).not.toContain('unlabelled bug')
    }
  })

  test('creates confirmed issues with hunt category and area labels', async () => {
    const finding = {
      id: 'F-test-1',
      area: 'clause-parser',
      category: 'false-verdict',
      title: 'green oracle lies',
      repro_path: '/tmp/urtext-hunt/test/repro',
      repro_command: 'timeout 5 npm test',
      expected: 'failure',
      observed: 'exit 0',
      confidence: 'confirmed',
    }
    let finderReturned = false
    const { runtime } = makeRuntime()
    runtime.adapters.gh.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    runtime.adapters.agent.mockImplementation(async (_prompt: string, opts: { model?: string }) => {
      if (opts.model === 'smol') {
        if (finderReturned) return { findings: [] }
        finderReturned = true
        return { findings: [finding] }
      }
      return { verdict: 'confirmed', observed: finding.observed }
    })

    await run(runtime)

    expect(runtime.adapters.gh.create).toHaveBeenCalledOnce()
    const args = runtime.adapters.gh.create.mock.calls[0][0]
    expect(args).toContain('--label')
    expect(args).toContain('hunt,false-verdict')
    expect(args).toContain('area:clause-parser')
  })
})
