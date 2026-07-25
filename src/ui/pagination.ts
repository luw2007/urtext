import { parsePositiveInt } from './contracts.js'

export const DEFAULT_PAGE_SIZE = 20
export const PAGE_SIZE_ENV = 'URTEXT_UI_PAGE_SIZE'

export interface PageWindow {
  page: number
  pageCount: number
  total: number
  start: number
  end: number
}

const PAGE_PATTERN = /^[1-9][0-9]*$/

export const readPageSize = (env: NodeJS.ProcessEnv): number => {
  const raw = env[PAGE_SIZE_ENV]
  return raw === undefined ? DEFAULT_PAGE_SIZE : parsePositiveInt(PAGE_SIZE_ENV, raw)
}

export const resolvePage = (search: URLSearchParams): number => {
  const values = search.getAll('page')
  if (values.length !== 1) return 1
  const raw = values[0]!
  // Overlong canonical integers may become Infinity; pageWindow clamps them.
  return PAGE_PATTERN.test(raw) ? Number(raw) : 1
}

export const pageWindow = (total: number, requested: number, pageSize: number): PageWindow => {
  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize)
  const page = Math.min(Math.max(requested, 1), pageCount)
  const start = (page - 1) * pageSize
  return { page, pageCount, total, start, end: Math.min(start + pageSize, total) }
}

export const pageHref = (basePath: string, page: number): string =>
  page === 1 ? basePath : `${basePath}?page=${page}`

export const paginationNav = (basePath: string, w: PageWindow): string => {
  if (w.pageCount === 1) return ''
  const previous =
    w.page === 1
      ? '<span data-tone="muted" aria-disabled="true">← 上一页</span>'
      : `<a rel="prev" href="${pageHref(basePath, w.page - 1)}">← 上一页</a>`
  const next =
    w.page === w.pageCount
      ? '<span data-tone="muted" aria-disabled="true">下一页 →</span>'
      : `<a rel="next" href="${pageHref(basePath, w.page + 1)}">下一页 →</a>`
  return `<nav aria-label="分页">${previous} <span>第 ${w.page} / 共 ${w.pageCount} 页（共 ${w.total} 条）</span> ${next}</nav>`
}
