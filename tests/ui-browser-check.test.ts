import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import type { CdpClient, RunCheckConfig } from '../scripts/ui-browser-check.js'
import {
  buildAssertions,
  captureFocusOrder,
  checkContrastPairs,
  computeExitCode,
  contrastRatio,
  evaluateHttpGuardCase,
  extractAxNodes,
  extractContrastPairs,
  extractDisclosureState,
  extractDiffIds,
  extractHeadings,
  extractLandmarks,
  extractOverflow,
  extractReducedMotion,
  HTTP_GUARD_CASES,
  hasHorizontalOverflow,
  missingAxLabels,
  missingLandmarks,
  reducedMotionHonored,
  rgbStringToHex,
  runCheckAtViewport,
  sanitizeRequestRecord,
  validateDisclosure,
  validateFocusOrder,
  validateHeadingOrder,
  validateRealDiffCount,
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
    expect(result.schema).toBe('urtext.ui-contrast-consumers/2')
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
  test('requires exactly one console, brief, and error page with no aliases', () => {
    expect(validatePageNames([{ name: 'console' }, { name: 'brief' }, { name: 'error' }])).toEqual([])
    expect(validatePageNames([{ name: 'console' }, { name: 'detail' }, { name: 'error' }])).toEqual([
      'expected exactly one brief page',
      'unknown page name "detail"',
    ])
    expect(validatePageNames([{ name: 'console' }, { name: 'brief' }, { name: 'brief' }, { name: 'error' }])).toEqual([
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
      { 'agent-lane': true, 'raw-brief': false },
      [
        { id: 'agent-lane', expectedOpen: false },
        { id: 'raw-brief', expectedOpen: false },
      ],
    )
    expect(errors).toEqual(['agent-lane: expected open=false, got open=true'])
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
    const client = fakeClient({ 'Runtime.evaluate': evalValue({ 'agent-lane': true }) })
    await expect(extractDisclosureState(client)).resolves.toEqual({ 'agent-lane': true })
  })
})

describe('extractDiffIds', () => {
  test('parses real blame-diff block ids from the injected client', async () => {
    const client = fakeClient({ 'Runtime.evaluate': evalValue(['d1', 'd2', 'd3']) })
    await expect(extractDiffIds(client)).resolves.toEqual(['d1', 'd2', 'd3'])
  })
})

describe('extractAxNodes', () => {
  test('maps real Accessibility.getFullAXTree nodes and drops ignored ones', async () => {
    const client = fakeClient({
      'Accessibility.getFullAXTree': {
        nodes: [
          { role: { value: 'button' }, name: { value: '' }, ignored: false },
          { role: { value: 'generic' }, name: { value: 'skip' }, ignored: true },
          { role: { value: 'link' }, name: { value: 'Home' }, ignored: false },
        ],
      },
    })
    await expect(extractAxNodes(client)).resolves.toEqual([
      { role: 'button', name: '', interactive: true },
      { role: 'link', name: 'Home', interactive: true },
    ])
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
    const disclosure = overrides.disclosure ?? { 'agent-lane': false }
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
    disclosureExpectations: [{ id: 'agent-lane', expectedOpen: false }],
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
    const client = buildDispatcher({ disclosure: { 'agent-lane': true } })
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
})
