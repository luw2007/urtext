import { describe, expect, test } from 'vitest'

import {
  checkContrastPairs,
  contrastRatio,
  evaluateHttpGuardCase,
  HTTP_GUARD_CASES,
  hasHorizontalOverflow,
  missingAxLabels,
  missingLandmarks,
  reducedMotionHonored,
  sanitizeRequestRecord,
  validateConfigThresholds,
  validateDisclosure,
  validateFocusOrder,
  validateHeadingOrder,
  validateRealDiffCount,
  VIEWPORTS,
} from '../scripts/ui-browser-check.js'

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

describe('validateConfigThresholds', () => {
  test('accepts the documented defaults', () => {
    expect(validateConfigThresholds({ diffOpenMaxLines: 80, diffDisplayMaxLines: 2000 })).toEqual([])
  })

  test('rejects non-positive and inverted thresholds', () => {
    expect(validateConfigThresholds({ diffOpenMaxLines: 0, diffDisplayMaxLines: 2000 })).toContain(
      'diffOpenMaxLines must be a positive integer',
    )
    expect(validateConfigThresholds({ diffOpenMaxLines: 100, diffDisplayMaxLines: 50 })).toContain(
      'diffOpenMaxLines must not exceed diffDisplayMaxLines',
    )
  })
})

describe('validateRealDiffCount', () => {
  test('the C004 fixture brief must show exactly five real mapping diffs', () => {
    expect(validateRealDiffCount(['d1', 'd2', 'd3', 'd4', 'd5'])).toBe(true)
    expect(validateRealDiffCount(['d1', 'd2'])).toBe(false)
  })
})

describe('HTTP_GUARD_CASES / evaluateHttpGuardCase', () => {
  test('covers bad Host, wrong media type, and missing CSRF/Origin on writes', () => {
    expect(HTTP_GUARD_CASES.map((c) => c.name)).toEqual([
      'bad-host-get',
      'wrong-media-type-post',
      'missing-csrf-post',
      'missing-origin-post',
    ])
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
