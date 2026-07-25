import { describe, expect, test } from 'vitest'

import {
  DEFAULT_PAGE_SIZE,
  pageHref,
  pageWindow,
  paginationNav,
  readPageSize,
  resolvePage,
} from '../src/ui/pagination.js'

describe('resolvePage', () => {
  test.each([undefined, '', '0', '-1', '01', '1.5', '+1', 'abc', '1e3'])(
    'resolves %s to page one',
    (value) => {
      const search = new URLSearchParams()
      if (value !== undefined) search.append('page', value)
      expect(resolvePage(search)).toBe(1)
    }
  )

  test('accepts canonical positive integers after URLSearchParams percent decoding', () => {
    expect(resolvePage(new URLSearchParams('page=1'))).toBe(1)
    expect(resolvePage(new URLSearchParams('page=%32'))).toBe(2)
    expect(resolvePage(new URLSearchParams('page=2'))).toBe(2)
  })

  test.each(['page=1&page=2', 'page=2&page=2'])('resolves repeated values to page one: %s', (query) => {
    expect(resolvePage(new URLSearchParams(query))).toBe(1)
  })

  test('leaves an overlong canonical integer for pageWindow to clamp', () => {
    expect(resolvePage(new URLSearchParams(`page=${'9'.repeat(400)}`))).toBe(Infinity)
  })
})

describe('pageWindow', () => {
  test.each([0, 1, 19, 20, 21, 40, 41, 44])('partitions total=%i without gaps or overlap', (total) => {
    for (const pageSize of [1, 20]) {
      const first = pageWindow(total, 1, pageSize)
      const windows = Array.from({ length: first.pageCount }, (_, index) => pageWindow(total, index + 1, pageSize))
      expect(first.pageCount).toBe(total === 0 ? 1 : Math.ceil(total / pageSize))
      for (const win of windows.slice(0, -1)) expect(win.end - win.start).toBe(pageSize)
      expect(windows.reduce((sum, win) => sum + win.end - win.start, 0)).toBe(total)
      for (let index = 1; index < windows.length; index++) expect(windows[index]!.start).toBe(windows[index - 1]!.end)
      expect(windows[0]!.start).toBe(0)
      expect(windows.at(-1)!.end).toBe(total)
    }
  })

  test('clamps non-positive and infinite requests to the first and last valid pages', () => {
    expect(pageWindow(44, 0, 20)).toEqual({ page: 1, pageCount: 3, total: 44, start: 0, end: 20 })
    expect(pageWindow(44, Infinity, 20)).toEqual({ page: 3, pageCount: 3, total: 44, start: 40, end: 44 })
    expect(pageWindow(1, 2, 20).page).toBe(1)
  })

  test('represents an empty collection as one empty page', () => {
    expect(pageWindow(0, Infinity, 20)).toEqual({ page: 1, pageCount: 1, total: 0, start: 0, end: 0 })
  })
})

describe('pageHref and paginationNav', () => {
  test('omits the page query only for page one', () => {
    expect(pageHref('/specs', 1)).toBe('/specs')
    expect(pageHref('/specs', 2)).toBe('/specs?page=2')
  })

  test('omits pagination for a single page', () => {
    expect(paginationNav('/specs', pageWindow(1, 1, 20))).toBe('')
    expect(paginationNav('/specs', pageWindow(0, 1, 20))).toBe('')
  })

  test('renders disabled endpoints and live middle links with canonical hrefs', () => {
    const first = paginationNav('/specs', pageWindow(44, 1, 20))
    expect(first).toContain('<nav aria-label="分页">')
    expect(first).toContain('data-tone="muted" aria-disabled="true">← 上一页</span>')
    expect(first).not.toContain('rel="prev"')
    expect(first).toContain('rel="next" href="/specs?page=2"')
    expect(first).toContain('第 1 / 共 3 页（共 44 条）')

    const middle = paginationNav('/specs', pageWindow(44, 2, 20))
    expect(middle).toContain('rel="prev" href="/specs"')
    expect(middle).toContain('rel="next" href="/specs?page=3"')
    expect(middle).toContain('第 2 / 共 3 页（共 44 条）')
    expect(middle).not.toContain('aria-disabled')

    const last = paginationNav('/specs', pageWindow(44, 3, 20))
    expect(last).toContain('rel="prev" href="/specs?page=2"')
    expect(last).not.toContain('rel="next"')
    expect(last).toContain('data-tone="muted" aria-disabled="true">下一页 →</span>')
  })
})

describe('readPageSize', () => {
  test('uses the default when the environment variable is absent', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20)
    expect(readPageSize({})).toBe(20)
  })

  test('accepts a configured positive integer', () => {
    expect(readPageSize({ URTEXT_UI_PAGE_SIZE: '5' })).toBe(5)
  })

  test.each(['0', '-1', 'abc', ''])('rejects invalid configured size %j', (value) => {
    expect(() => readPageSize({ URTEXT_UI_PAGE_SIZE: value })).toThrow('URTEXT_UI_PAGE_SIZE must be a positive integer')
  })
})
