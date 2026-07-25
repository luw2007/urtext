import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import type { CdpClient, RunCheckConfig } from '../scripts/ui-browser-check.js'
import {
  accessibleNameSource,
  attachNetworkGuard,
  buildAssertions,
  collectPageAxLinks,
  captureFocusOrder,
  checkContrastPairs,
  computeExitCode,
  contrastRatio,
  decideFetchAction,
  evaluateHttpGuardCase,
  extractAxNodes,
  extractContrastPairs,
  extractDisclosureState,
  extractDiffIds,
  extractHeadings,
  extractLandmarks,
  extractOverflow,
  extractReducedMotion,
  extractSelectorCounts,
  HTTP_GUARD_CASES,
  hasHorizontalOverflow,
  linkSelectorToAxNode,
  missingAxLabels,
  missingLandmarks,
  PAGE_SPECIFIC_SELECTORS,
  reducedMotionHonored,
  resolveSelectorBackendNodeId,
  rgbStringToHex,
  runCheckAtViewport,
  sanitizeRequestRecord,
  validateAxTreeClosure,
  validateDisclosure,
  validateFocusOrder,
  validateHeadingOrder,
  validatePageSpecificSelectors,
  validateRealDiffCount,
  verifyButtonDisablesDuringSubmit,
  VIEWPORTS,
  waitForPageLoad,
  verifyContrastManifest,
  validatePageNames,
} from '../scripts/ui-browser-check.js'

describe('verifyContrastManifest', () => {
  const root = join(__dirname, '..')
  const manifestPath = join(__dirname, 'ui-contrast-manifest.json')

  test('recomputes both current source and render contracts', () => {
    const result = verifyContrastManifest(manifestPath, root)
    expect(result.schema).toBe('urtext.ui-contrast-consumers/3')
    expect(result.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.assertions).toHaveLength(2)
    expect(result.assertions.every((assertion) => assertion.pass)).toBe(true)
  })

  test('fails closed when the recorded source hash is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'urtext-stale-contrast-'))
    try {
      const stale = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      stale.sourceContractSha256 = '0'.repeat(64)
      const path = join(dir, 'manifest.json')
      writeFileSync(path, JSON.stringify(stale))
      const result = verifyContrastManifest(path, root)
      expect(result.assertions.find((assertion) => assertion.name.includes('source-contract'))?.pass).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validatePageNames', () => {
  const SEVEN_PAGES = [
    { name: 'console' },
    { name: 'agent' },
    { name: 'specs' },
    { name: 'specs-page-2' },
    { name: 'decisions' },
    { name: 'brief' },
    { name: 'error' },
  ]

  test('requires exactly one of each of the seven approved pages with no aliases', () => {
    expect(validatePageNames(SEVEN_PAGES)).toEqual([])
    expect(validatePageNames([...SEVEN_PAGES.filter((p) => p.name !== 'agent'), { name: 'detail' }])).toEqual([
      'expected exactly one agent page',
      'unknown page name "detail"',
    ])
    expect(validatePageNames([...SEVEN_PAGES, { name: 'brief' }])).toEqual([
      'expected exactly one brief page',
    ])
  })
})

describe('VIEWPORTS', () => {
  test('is exactly the three required breakpoints', () => {
    expect(VIEWPORTS).toEqual([1440, 1024, 390])
  })
})

describe('contrastRatio', () => {
  test('black on white is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })

  test('is order-independent', () => {
    expect(contrastRatio('#116329', '#eaf5ec')).toBeCloseTo(contrastRatio('#eaf5ec', '#116329'), 10)
  })

  test('same color is 1:1', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
  })

  test('rejects a malformed hex color', () => {
    expect(() => contrastRatio('not-a-color', '#ffffff')).toThrow(/invalid hex color/)
  })
})

describe('checkContrastPairs', () => {
  test('flags every theme token pair below 4.5:1 and passes the ones at/above it', () => {
    const results = checkContrastPairs([
      { label: 'fg/bg light', fg: '#1a1a1a', bg: '#ffffff' },
      { label: 'warn/warn-bg light', fg: '#966400', bg: '#fff3d6' },
      { label: 'too-low', fg: '#cccccc', bg: '#ffffff' },
    ])
    expect(results.find((r) => r.label === 'fg/bg light')?.pass).toBe(true)
    expect(results.find((r) => r.label === 'warn/warn-bg light')?.pass).toBe(true)
    expect(results.find((r) => r.label === 'too-low')?.pass).toBe(false)
  })
})

describe('missingLandmarks', () => {
  test('passes when main/header/nav are all present', () => {
    expect(missingLandmarks(['header', 'nav', 'main'])).toEqual([])
  })

  test('reports every missing landmark', () => {
    expect(missingLandmarks(['header'])).toEqual(['main', 'nav'])
  })
})

describe('validateHeadingOrder', () => {
  test('passes a single h1 followed by non-skipping levels', () => {
    expect(validateHeadingOrder([{ level: 1, text: 'a' }, { level: 2, text: 'b' }, { level: 3, text: 'c' }])).toEqual([])
  })

  test('rejects zero or multiple h1s', () => {
    expect(validateHeadingOrder([{ level: 2, text: 'a' }])).toContain('expected exactly one h1, found 0')
    expect(
      validateHeadingOrder([{ level: 1, text: 'a' }, { level: 1, text: 'b' }]),
    ).toContain('expected exactly one h1, found 2')
  })

  test('rejects a skipped level', () => {
    const errors = validateHeadingOrder([{ level: 1, text: 'a' }, { level: 3, text: 'b' }])
    expect(errors.some((e) => e.includes('h1 -> h3'))).toBe(true)
  })
})

describe('missingAxLabels', () => {
  test('flags interactive nodes with an empty accessible name', () => {
    const nodes = [
      { role: 'button', name: '', interactive: true },
      { role: 'button', name: 'Approve', interactive: true },
      { role: 'link', name: '   ', interactive: false },
    ]
    const flagged = missingAxLabels(nodes)
    expect(flagged.map((n) => n.role)).toEqual(['button', 'link'])
  })
})

describe('validateFocusOrder', () => {
  test('requires the skip link first', () => {
    expect(validateFocusOrder(['skip-link', 'nav-1', 'nav-2'])).toEqual([])
    expect(validateFocusOrder(['nav-1', 'skip-link'])[0]).toMatch(/first focusable element must be the skip link/)
  })

  test('flags duplicate focus stops', () => {
    expect(validateFocusOrder(['skip-link', 'a', 'a'])).toContain('duplicate focus stop a')
  })
})

describe('hasHorizontalOverflow', () => {
  test('true only when scrollWidth exceeds clientWidth', () => {
    expect(hasHorizontalOverflow(1440, 1440)).toBe(false)
    expect(hasHorizontalOverflow(1600, 1440)).toBe(true)
  })
})

describe('reducedMotionHonored', () => {
  test('requires both transition and animation to compute to none', () => {
    expect(reducedMotionHonored('none', 'none')).toBe(true)
    expect(reducedMotionHonored('all 0.2s', 'none')).toBe(false)
  })
})

describe('validateDisclosure', () => {
  test('flags a mismatch between observed and expected open state', () => {
    const errors = validateDisclosure(
      { 'blame-diff': true, 'raw-brief': false },
      [
        { id: 'blame-diff', expectedOpen: false },
        { id: 'raw-brief', expectedOpen: false },
      ],
    )
    expect(errors).toEqual(['blame-diff: expected open=false, got open=true'])
  })
})

describe('validateRealDiffCount', () => {
  test('the C004 fixture brief must show exactly five real mapping diffs', () => {
    expect(validateRealDiffCount(['d1', 'd2', 'd3', 'd4', 'd5'])).toBe(true)
    expect(validateRealDiffCount(['d1', 'd2'])).toBe(false)
  })

  test('non-brief pages pass only when they contain no mapping diffs', () => {
    expect(validateRealDiffCount([], 0)).toBe(true)
    expect(validateRealDiffCount(['unexpected'], 0)).toBe(false)
  })
})

describe('HTTP_GUARD_CASES / evaluateHttpGuardCase', () => {
  test('covers bad Host, wrong media type, missing CSRF, and hostile Origin on the real write route', () => {
    expect(HTTP_GUARD_CASES.map((c) => c.name)).toEqual([
      'bad-host-get',
      'wrong-media-type-post',
      'missing-csrf-post',
      'hostile-origin-post',
    ])
    expect(HTTP_GUARD_CASES.slice(1).every((c) => c.path === '/api/decide')).toBe(true)
    expect(HTTP_GUARD_CASES[0]?.expectedStatus).toBe(403)
  })

  test('passes only when the observed status matches the expected status exactly', () => {
    const badHost = HTTP_GUARD_CASES[0]!
    expect(evaluateHttpGuardCase(badHost, badHost.expectedStatus)).toBe(true)
    expect(evaluateHttpGuardCase(badHost, 200)).toBe(false)
  })
})

describe('sanitizeRequestRecord', () => {
  test('redacts deny-listed keys at any nesting depth, case-insensitively', () => {
    const sanitized = sanitizeRequestRecord({
      method: 'POST',
      Authorization: 'Bearer secret',
      body: { csrf: 'token-abc', prompt: 'do the thing', nested: { Cookie: 'session=1' } },
    }) as Record<string, unknown>
    expect(sanitized.method).toBe('POST')
    expect(sanitized.Authorization).toBe('[REDACTED]')
    const body = sanitized.body as Record<string, unknown>
    expect(body.csrf).toBe('[REDACTED]')
    expect(body.prompt).toBe('[REDACTED]')
    expect((body.nested as Record<string, unknown>).Cookie).toBe('[REDACTED]')
  })

  test('leaves non-deny-listed values untouched and redacts array elements', () => {
    const sanitized = sanitizeRequestRecord({ status: 200, argv: ['--model', 'x'] }) as Record<string, unknown>
    expect(sanitized.status).toBe(200)
    expect(sanitized.argv).toBe('[REDACTED]')
  })
})

const evalValue = (value: unknown): { result: { value: string } } => ({ result: { value: JSON.stringify(value) } })

/** A fake `CdpClient` whose `send` returns queued responses keyed by method, proving each extractor really reads `client.send()` output and nothing is hardcoded. */
const fakeClient = (responses: Record<string, unknown>): CdpClient => ({
  send: vi.fn(async (method: string) => {
    if (!(method in responses)) throw new Error(`unexpected CDP call ${method}`)
    return responses[method]
  }),
  close: vi.fn(),
})

describe('rgbStringToHex', () => {
  test('converts a computed rgb() string to lowercase hex', () => {
    expect(rgbStringToHex('rgb(26, 26, 26)')).toBe('#1a1a1a')
    expect(rgbStringToHex('rgba(255, 255, 255, 1)')).toBe('#ffffff')
  })

  test('rejects an unparseable color', () => {
    expect(() => rgbStringToHex('currentcolor')).toThrow(/unparseable computed color/)
  })
})

describe('extractLandmarks', () => {
  test('parses the real tag list returned by the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue(['header', 'nav', 'main']) })
    await expect(extractLandmarks(client)).resolves.toEqual(['header', 'nav', 'main'])
  })
})

describe('extractHeadings', () => {
  test('parses the real heading list returned by the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue([{ level: 1, text: 'title' }]) })
    await expect(extractHeadings(client)).resolves.toEqual([{ level: 1, text: 'title' }])
  })
})

describe('extractOverflow', () => {
  test('parses real scrollWidth/clientWidth from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue({ scrollWidth: 1600, clientWidth: 1440 }) })
    await expect(extractOverflow(client)).resolves.toEqual({ scrollWidth: 1600, clientWidth: 1440 })
  })
})

describe('extractReducedMotion', () => {
  test('parses real computed transition/animation from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue({ transition: 'all 0.2s', animation: 'none' }) })
    await expect(extractReducedMotion(client)).resolves.toEqual({ transition: 'all 0.2s', animation: 'none' })
  })
})

describe('extractDisclosureState', () => {
  test('parses real data-section keyed open state from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue({ 'blame-diff': true }) })
    await expect(extractDisclosureState(client)).resolves.toEqual({ 'blame-diff': true })
  })
})

describe('extractDiffIds', () => {
  test('parses real blame-diff block ids from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue(['d1', 'd2', 'd3']) })
    await expect(extractDiffIds(client)).resolves.toEqual(['d1', 'd2', 'd3'])
  })
})

describe('extractAxNodes', () => {
  test('maps the full AX tree, preserving ignored ancestors for closure', async () => {
    const client = fakeClient({
      'Accessibility.getFullAXTree': {
        nodes: [
          { nodeId: '1', role: { value: 'generic' }, name: { value: '' }, ignored: true },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: '' }, ignored: false },
          { nodeId: '3', parentId: '1', role: { value: 'link' }, name: { value: 'Home' }, ignored: false },
        ],
      },
    })
    const nodes = await extractAxNodes(client)
    expect(nodes).toEqual([
      { role: 'generic', name: '', interactive: false, ignored: true, nodeId: '1' },
      { role: 'button', name: '', interactive: true, ignored: false, nodeId: '2', parentId: '1' },
      { role: 'link', name: 'Home', interactive: true, ignored: false, nodeId: '3', parentId: '1' },
    ])
    expect(validateAxTreeClosure(nodes)).toEqual([])
    expect(missingAxLabels(nodes)).toEqual([nodes[1]])
  })

  test('carries nodeId/parentId/backendDOMNodeId/nameSources through for DOM<->AX linkage', async () => {
    const client = fakeClient({
      'Accessibility.getFullAXTree': {
        nodes: [
          {
            nodeId: '5',
            parentId: '1',
            backendDOMNodeId: 42,
            role: { value: 'button' },
            name: { value: 'Run audit', sources: [{ type: 'contents', attempted: true }] },
            ignored: false,
          },
        ],
      },
    })
    const [node] = await extractAxNodes(client)
    expect(node).toEqual({
      role: 'button',
      name: 'Run audit',
      interactive: true,
      ignored: false,
      nodeId: '5',
      parentId: '1',
      backendDOMNodeId: 42,
      nameSources: ['contents'],
    })
  })
})

describe('extractContrastPairs', () => {
  test('converts the injected client rgb() pairs to hex ContrastPair records', async () => {
    const client = fakeClient({
      'Runtime.evaluate': evalValue([{ label: 'p-0', fg: 'rgb(26, 26, 26)', bg: 'rgb(255, 255, 255)' }]),
    })
    await expect(extractContrastPairs(client)).resolves.toEqual([{ label: 'p-0', fg: '#1a1a1a', bg: '#ffffff' }])
  })
})

describe('captureFocusOrder', () => {
  test('dispatches real Tab key events and maps the skip anchor to skip-link', async () => {
    const activeIds = ['skip-link', 'main']
    let call = 0
    const client: CdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === 'Input.dispatchKeyEvent') return {}
        if (method === 'Runtime.evaluate') return { result: { value: activeIds[call++] } }
        throw new Error(`unexpected ${method}`)
      }),
      close: vi.fn(),
    }
    const order = await captureFocusOrder(client, 2)
    expect(order).toEqual(['skip-link', 'main'])
    expect(client.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ key: 'Tab', type: 'keyDown' }))
  })

  test('distinguishes separate focusable elements that have no id', async () => {
    const client: CdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === 'Input.dispatchKeyEvent') return {}
        if (method === 'Runtime.evaluate') return { result: { value: 'a@17' } }
        throw new Error(`unexpected ${method}`)
      }),
      close: vi.fn(),
    }
    await expect(captureFocusOrder(client, 1)).resolves.toEqual(['a@17'])
    expect(client.send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: expect.stringContaining('document.querySelectorAll') }),
    )
  })

  test('stops after one complete tab cycle instead of reporting normal wraparound as duplication', async () => {
    const activeIds = ['skip-link', 'a@10', 'skip-link']
    let call = 0
    const client: CdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === 'Input.dispatchKeyEvent') return {}
        if (method === 'Runtime.evaluate') return { result: { value: activeIds[call++] } }
        throw new Error(`unexpected ${method}`)
      }),
      close: vi.fn(),
    }
    await expect(captureFocusOrder(client, 3)).resolves.toEqual(['skip-link', 'a@10'])
  })
})

describe('waitForPageLoad', () => {
  test('polls document.readyState via the injected client until complete', async () => {
    const states = ['loading', 'interactive', 'complete']
    let call = 0
    const client = fakeClient({})
    client.send = vi.fn(async () => ({ result: { value: states[call++] } }))
    await waitForPageLoad(client, 5000, 0)
    expect(client.send).toHaveBeenCalledTimes(3)
  })

  test('throws if the page never reaches complete before the timeout', async () => {
    const client = fakeClient({})
    client.send = vi.fn(async () => ({ result: { value: 'loading' } }))
    await expect(waitForPageLoad(client, 10, 5)).rejects.toThrow(/page load timed out/)
  })
})

describe('runCheckAtViewport / buildAssertions / computeExitCode — full wiring and failure injection', () => {
  const buildDispatcher = (overrides: Partial<{
    landmarks: string[]
    headings: { level: number; text: string }[]
    overflow: { scrollWidth: number; clientWidth: number }
    motion: { transition: string; animation: string }
    disclosure: Record<string, boolean>
    diffIds: string[]
    contrast: { label: string; fg: string; bg: string }[]
    focusIds: string[]
    axNodes: { role: { value: string }; name: { value: string }; ignored?: boolean }[]
  }>): CdpClient => {
    const landmarks = overrides.landmarks ?? ['header', 'nav', 'main']
    const headings = overrides.headings ?? [{ level: 1, text: 'h' }]
    const overflow = overrides.overflow ?? { scrollWidth: 1440, clientWidth: 1440 }
    const motion = overrides.motion ?? { transition: 'none', animation: 'none' }
    const disclosure = overrides.disclosure ?? { 'blame-diff': false }
    const diffIds = overrides.diffIds ?? ['d1', 'd2', 'd3', 'd4', 'd5']
    const contrast = overrides.contrast ?? [{ label: 'p-0', fg: 'rgb(26, 26, 26)', bg: 'rgb(255, 255, 255)' }]
    const focusIds = overrides.focusIds ?? ['skip-link']
    const axNodes = overrides.axNodes ?? [{ role: { value: 'link' }, name: { value: 'Home' }, ignored: false }]

    let focusCall = 0
    return {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes }
        if (method === 'Input.dispatchKeyEvent') return {}
        if (method === 'Runtime.evaluate') {
          const expr = String(params?.expression ?? '')
          if (expr.includes('querySelectorAll("main,header,nav")')) return evalValue(landmarks)
          if (expr.includes('h1,h2,h3,h4,h5,h6')) return evalValue(headings)
          if (expr.includes('scrollWidth')) return evalValue(overflow)
          if (expr.includes('transitionProperty')) return evalValue(motion)
          if (expr.includes('data-section]')) return evalValue(disclosure)
          if (expr.includes('blame-diff')) return evalValue(diffIds)
          if (expr.includes('document.activeElement')) return { result: { value: focusIds[focusCall++] ?? '' } }
          if (expr.includes("querySelectorAll('body *')")) return evalValue(contrast)
          throw new Error(`unexpected Runtime.evaluate expression: ${expr}`)
        }
        throw new Error(`unexpected CDP call ${method}`)
      }),
      close: vi.fn(),
    }
  }

  const config: RunCheckConfig = {
    focusSteps: 1,
    expectedDiffCount: 5,
    disclosureExpectations: [{ id: 'blame-diff', expectedOpen: false }],
    guardCases: [],
  }

  test('wires every field from the injected client — no field is a fixed placeholder', async () => {
    const client = buildDispatcher({})
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    expect(summary).toMatchObject({
      page: 'console',
      viewport: 1440,
      colorScheme: 'light',
      landmarkErrors: [],
      headingErrors: [],
      axLabelErrors: [],
      focusErrors: [],
      horizontalOverflow: false,
      reducedMotionOk: true,
      disclosureErrors: [],
      realDiffCount: true,
    })
    expect(summary.contrast[0]?.pass).toBe(true)
    expect(buildAssertions(summary).every((a) => a.pass)).toBe(true)
    expect(computeExitCode([summary])).toBe(0)
  })

  test('an injected missing landmark fails the corresponding assertion and the exit code', async () => {
    const client = buildDispatcher({ landmarks: ['header'] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    expect(summary.landmarkErrors).toEqual(['main', 'nav'])
    const landmarkAssertion = buildAssertions(summary).find((a) => a.name.endsWith(':landmarks'))
    expect(landmarkAssertion?.pass).toBe(false)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected duplicate h1 fails the heading assertion and the exit code', async () => {
    const client = buildDispatcher({ headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'brief', 1024, 'dark', config)
    expect(summary.headingErrors.length).toBeGreaterThan(0)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected unlabeled interactive AX node fails the ax-labels assertion', async () => {
    const client = buildDispatcher({ axNodes: [{ role: { value: 'button' }, name: { value: '' } }] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'brief', 390, 'light', config)
    expect(summary.axLabelErrors).toHaveLength(1)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected horizontal overflow fails its assertion', async () => {
    const client = buildDispatcher({ overflow: { scrollWidth: 1600, clientWidth: 1440 } })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 390, 'light', config)
    expect(summary.horizontalOverflow).toBe(true)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected active transition under reduced-motion fails its assertion', async () => {
    const client = buildDispatcher({ motion: { transition: 'all 0.2s', animation: 'none' } })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'dark', config)
    expect(summary.reducedMotionOk).toBe(false)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected disclosure state mismatch fails its assertion', async () => {
    const client = buildDispatcher({ disclosure: { 'blame-diff': true } })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    expect(summary.disclosureErrors).toHaveLength(1)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected wrong diff count fails the real-diff-count assertion', async () => {
    const client = buildDispatcher({ diffIds: ['d1', 'd2'] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'brief', 1440, 'light', config)
    expect(summary.realDiffCount).toBe(false)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected low-contrast pair fails its contrast assertion', async () => {
    const client = buildDispatcher({ contrast: [{ label: 'low', fg: 'rgb(204, 204, 204)', bg: 'rgb(255, 255, 255)' }] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    expect(summary.contrast[0]?.pass).toBe(false)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('an injected out-of-order focus capture (skip link not first) fails the focus assertion', async () => {
    const client = buildDispatcher({ focusIds: ['nav-1'] })
    const summary = await runCheckAtViewport(client, 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    expect(summary.focusErrors.length).toBeGreaterThan(0)
    expect(computeExitCode([summary])).toBe(1)
  })

  test('a passing summary alongside one injected-failing summary still fails the overall exit code', async () => {
    const ok = await runCheckAtViewport(buildDispatcher({}), 'http://127.0.0.1:9', 'console', 1440, 'light', config)
    const bad = await runCheckAtViewport(buildDispatcher({ landmarks: [] }), 'http://127.0.0.1:9', 'error', 1440, 'light', config)
    expect(computeExitCode([ok, bad])).toBe(1)
    expect(computeExitCode([ok])).toBe(0)
  })
  test('an injected DOM/AX linkage failure reaches the summary assertion and exit code', async () => {
    const base = buildDispatcher({ axNodes: [{ role: { value: 'button' }, name: { value: 'Run audit' }, ignored: false }] })
    const originalSend = base.send
    base.send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 5 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42, attributes: ['class', 'id', 'id', 'audit-runner'] } }
      return originalSend(method, params)
    })
    const summary = await runCheckAtViewport(base, 'http://127.0.0.1:9', 'console', 1440, 'light', {
      ...config,
      axLinkSelectors: { console: ['#audit-runner'] },
    })
    expect(summary.axLinkErrors).toHaveLength(1)
    expect(buildAssertions(summary).find((assertion) => assertion.name.endsWith(':dom-ax-linkage'))?.pass).toBe(false)
    expect(computeExitCode([summary])).toBe(1)
  })

})


describe('accessibleNameSource', () => {
  test('reports the first attempted name source', () => {
    expect(accessibleNameSource({ role: 'button', name: 'Run audit', interactive: true, nameSources: ['contents', 'attribute'] })).toBe('contents')
  })

  test('reports "unknown" when a name exists but no source was recorded', () => {
    expect(accessibleNameSource({ role: 'button', name: 'Run audit', interactive: true })).toBe('unknown')
  })

  test('reports "none" for an unnamed node', () => {
    expect(accessibleNameSource({ role: 'generic', name: '  ', interactive: false })).toBe('none')
  })
})

describe('validateAxTreeClosure', () => {
  test('a fully-closed tree (every parentId resolves) has no errors', () => {
    const nodes = [
      { role: 'RootWebArea', name: '', interactive: false, nodeId: '1' },
      { role: 'button', name: 'Run audit', interactive: true, nodeId: '2', parentId: '1' },
    ]
    expect(validateAxTreeClosure(nodes)).toEqual([])
  })

  test('an injected dangling parentId is reported as a closure error', () => {
    const nodes = [{ role: 'button', name: 'Run audit', interactive: true, nodeId: '2', parentId: '999' }]
    expect(validateAxTreeClosure(nodes)).toEqual(['AX node 2 (button) has dangling parentId 999'])
  })
})

describe('resolveSelectorBackendNodeId', () => {
  test('resolves a selector through DOM.getDocument -> DOM.querySelector -> DOM.describeNode', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 5 },
      'DOM.describeNode': { node: { backendNodeId: 42 } },
    })
    await expect(resolveSelectorBackendNodeId(client, '#explain-btn')).resolves.toBe(42)
  })

  test('an injected missing selector (nodeId 0) throws instead of resolving a fake id', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 0 },
    })
    await expect(resolveSelectorBackendNodeId(client, '#missing')).rejects.toThrow(/selector not found in DOM/)
  })
})

describe('linkSelectorToAxNode', () => {
  test('links a selector to the AX node that carries the matching backendDOMNodeId', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 5 },
      'DOM.describeNode': { node: { backendNodeId: 42, attributes: ['id', 'audit-runner'] } },
    })
    const axNodes = [{ role: 'button', name: 'Run audit', interactive: true, nodeId: 'ax-42', backendDOMNodeId: 42, nameSources: ['contents'] }]
    await expect(linkSelectorToAxNode(client, '#audit-runner', axNodes)).resolves.toEqual({
      selector: '#audit-runner',
      domNodeId: 5,
      domId: 'audit-runner',
      backendDOMNodeId: 42,
      axNodeId: 'ax-42',
      role: 'button',
      name: 'Run audit',
      accessibleNameSource: 'contents',
    })
  })

  test('an injected AX tree missing the resolved backendDOMNodeId fails linkage instead of silently passing', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 5 },
      'DOM.describeNode': { node: { backendNodeId: 42 } },
    })
    const axNodes = [{ role: 'button', name: 'Run audit', interactive: true, backendDOMNodeId: 7 }]
    await expect(linkSelectorToAxNode(client, '#audit-runner', axNodes)).rejects.toThrow(/no AX node carries backendDOMNodeId 42/)
  })
})

describe('collectPageAxLinks', () => {
  test('records a DOM-backed AX identity for every configured selector', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 5 },
      'DOM.describeNode': { node: { backendNodeId: 42, attributes: ['id', 'main'] } },
    })
    const result = await collectPageAxLinks(
      client,
      'console',
      [{ role: 'main', name: 'Main', interactive: false, nodeId: 'ax-main', backendDOMNodeId: 42, nameSources: ['contents'] }],
      { console: ['#main'] },
    )
    expect(result.errors).toEqual([])
    expect(result.links[0]).toMatchObject({ selector: '#main', domId: 'main', backendDOMNodeId: 42, axNodeId: 'ax-main' })
  })

  test('an injected selector without AX backing becomes a failing linkage record', async () => {
    const client = fakeClient({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 5 },
      'DOM.describeNode': { node: { backendNodeId: 42 } },
    })
    const result = await collectPageAxLinks(client, 'brief', [], { brief: ['#explain-btn'] })
    expect(result.links).toEqual([])
    expect(result.errors[0]).toContain('no AX node carries backendDOMNodeId 42')
  })
})

describe('extractSelectorCounts / validatePageSpecificSelectors', () => {
  test('parses real per-selector counts from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue({ '#audit-runner': 1, '#explain-btn': 0 }) })
    await expect(extractSelectorCounts(client, ['#audit-runner', '#explain-btn'])).resolves.toEqual({ '#audit-runner': 1, '#explain-btn': 0 })
  })

  test('console page with the expected counts passes', () => {
    expect(validatePageSpecificSelectors('console', { '#audit-runner': 0, '#explain-btn': 0 }, PAGE_SPECIFIC_SELECTORS)).toEqual([])
  })

  test('an injected leaked explain button on the console page fails page-specific presence', () => {
    expect(validatePageSpecificSelectors('console', { '#audit-runner': 0, '#explain-btn': 1 }, PAGE_SPECIFIC_SELECTORS)).toEqual([
      'console:#explain-btn: expected count 0, got 1',
    ])
  })

  test('an injected missing audit-runner on the agent page fails page-specific presence', () => {
    expect(validatePageSpecificSelectors('agent', { '#audit-runner': 0, '#explain-btn': 0 }, PAGE_SPECIFIC_SELECTORS)).toEqual([
      'agent:#audit-runner: expected count 1, got 0',
    ])
  })

  test('the error page has neither explain nor audit-runner', () => {
    expect(validatePageSpecificSelectors('error', { '#audit-runner': 0, '#explain-btn': 0 }, PAGE_SPECIFIC_SELECTORS)).toEqual([])
  })
})

describe('decideFetchAction', () => {
  test('continues a same-origin request', () => {
    expect(decideFetchAction('http://127.0.0.1:4173/api/decide', 'http://127.0.0.1:4173')).toEqual({ action: 'continue', originClass: 'same-origin' })
  })

  test('an injected external-origin request is failed, not silently allowed', () => {
    expect(decideFetchAction('https://evil.example/track', 'http://127.0.0.1:4173')).toEqual({ action: 'fail', originClass: 'external' })
  })
})

describe('attachNetworkGuard', () => {
  const fakeClientWithEvents = (): CdpClient & { emit: (method: string, params: unknown) => void } => {
    const handlers = new Map<string, ((params: unknown) => void)[]>()
    return {
      send: vi.fn(async () => ({})),
      on: vi.fn((method: string, handler: (params: unknown) => void) => {
        const list = handlers.get(method) ?? []
        list.push(handler)
        handlers.set(method, list)
      }),
      close: vi.fn(),
      emit: (method: string, params: unknown) => {
        for (const handler of handlers.get(method) ?? []) handler(params)
      },
    }
  }

  test('enables Network and Fetch with a catch-all request pattern before any request can be classified', async () => {
    const client = fakeClientWithEvents()
    await attachNetworkGuard(client, 'http://127.0.0.1:4173')
    expect(client.send).toHaveBeenCalledWith('Network.enable')
    expect(client.send).toHaveBeenCalledWith('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  })

  test('actively fails an external-origin request instead of merely observing it', async () => {
    const client = fakeClientWithEvents()
    const guard = await attachNetworkGuard(client, 'http://127.0.0.1:4173')
    client.emit('Fetch.requestPaused', { requestId: 'req-1', request: { url: 'https://evil.example/track' }, resourceType: 'Image' })
    expect(client.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'req-1', errorReason: 'BlockedByClient' })
    expect(client.send).not.toHaveBeenCalledWith('Fetch.continueRequest', expect.anything())
    expect(guard.getRecords()).toEqual([{ originClass: 'external', resourceType: 'Image', status: null }])
  })

  test('continues a same-origin request', async () => {
    const client = fakeClientWithEvents()
    const guard = await attachNetworkGuard(client, 'http://127.0.0.1:4173')
    client.emit('Fetch.requestPaused', { requestId: 'req-2', request: { url: 'http://127.0.0.1:4173/style.css' }, resourceType: 'Stylesheet' })
    expect(client.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'req-2' })
    expect(guard.getRecords()).toEqual([{ originClass: 'same-origin', resourceType: 'Stylesheet', status: null }])
  })

  test('sanitized records never carry the raw request URL', async () => {
    const client = fakeClientWithEvents()
    const guard = await attachNetworkGuard(client, 'http://127.0.0.1:4173')
    client.emit('Fetch.requestPaused', { requestId: 'req-3', request: { url: 'https://evil.example/track?token=secret' }, resourceType: 'XHR' })
    const record = guard.getRecords()[0] as unknown as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(['originClass', 'resourceType', 'status'])
    expect(JSON.stringify(record)).not.toContain('evil.example')
  })
})

describe('verifyButtonDisablesDuringSubmit', () => {
  /** A stateful fake CdpClient: `.disabled` is `false`, then flips `true` right after the real click dispatch, then `false` again after `reenableAfterPolls` reads. */
  const buildDisableFlow = (opts: { startsDisabled?: boolean; reenableAfterPolls?: number | null }): CdpClient => {
    const startsDisabled = opts.startsDisabled ?? false
    const reenableAfterPolls = opts.reenableAfterPolls === undefined ? 1 : opts.reenableAfterPolls
    let clicked = false
    let pollsSinceClick = 0
    return {
      send: vi.fn(async (method: string) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector') return { nodeId: 9 }
        if (method === 'DOM.scrollIntoViewIfNeeded') return {}
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
        if (method === 'Input.dispatchMouseEvent') {
          clicked = true
          return {}
        }
        if (method === 'Runtime.evaluate') {
          if (startsDisabled) return { result: { value: true } }
          if (!clicked) return { result: { value: false } }
          pollsSinceClick += 1
          if (reenableAfterPolls === null) return { result: { value: true } }
          return { result: { value: pollsSinceClick <= reenableAfterPolls } }
        }
        throw new Error(`unexpected ${method}`)
      }),
      close: vi.fn(),
    }
  }

  test('a real click disables the button during the request and re-enables it once settled', async () => {
    const client = buildDisableFlow({ reenableAfterPolls: 1 })
    const result = await verifyButtonDisablesDuringSubmit(client, '#explain-btn', 500, 1)
    expect(result).toEqual({ selector: '#explain-btn', initialDisabled: false, disabledDuringRequest: true, reenabled: true, pass: true })
    expect(client.send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }))
    expect(client.send).not.toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({ expression: expect.stringContaining('.disabled=') }))
  })

  test('an injected already-disabled button fails the check instead of a false pass', async () => {
    const client = buildDisableFlow({ startsDisabled: true })
    const result = await verifyButtonDisablesDuringSubmit(client, '#explain-btn', 200, 1)
    expect(result.pass).toBe(false)
    expect(result.initialDisabled).toBe(true)
  })

  test('an injected button that never re-enables times out and fails the check', async () => {
    const client = buildDisableFlow({ reenableAfterPolls: null })
    const result = await verifyButtonDisablesDuringSubmit(client, '#explain-btn', 60, 10)
    expect(result.disabledDuringRequest).toBe(true)
    expect(result.reenabled).toBe(false)
    expect(result.pass).toBe(false)
  })

  test('an injected selector that matches nothing in the DOM throws rather than faking a result', async () => {
    const client: CdpClient = {
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') return { result: { value: false } }
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector') return { nodeId: 0 }
        throw new Error(`unexpected ${method}`)
      }),
      close: vi.fn(),
    }
    await expect(verifyButtonDisablesDuringSubmit(client, '#missing')).rejects.toThrow(/selector not found in DOM/)
  })
})
