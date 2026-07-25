/**
 * W1 prerequisite renderer contract (urtext-20260724-ui-redesign §6.2).
 * Only new types/values; existing review-ui.ts contracts are untouched until
 * the I1 cutover re-exports from here.
 */
import type { Brief, BriefMapping, ClauseTarget } from '../brief.js'

export interface UiRenderConfig {
  diffOpenMaxLines: number
  diffDisplayMaxLines: number
}

export const DEFAULT_UI_RENDER_CONFIG: UiRenderConfig = {
  diffOpenMaxLines: 80,
  diffDisplayMaxLines: 2000,
}

const DIFF_OPEN_MAX_LINES_ENV = 'URTEXT_UI_DIFF_OPEN_MAX_LINES'
const DIFF_DISPLAY_MAX_LINES_ENV = 'URTEXT_UI_DIFF_DISPLAY_MAX_LINES'

const parsePositiveInt = (name: string, raw: string): number => {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return value
}

/** Reads validated render thresholds from the environment. Unset variables
 * fall back to the default; present-but-invalid values fail fast. */
export const readUiRenderConfig = (env: NodeJS.ProcessEnv): UiRenderConfig => {
  const diffOpenMaxLinesRaw = env[DIFF_OPEN_MAX_LINES_ENV]
  const diffDisplayMaxLinesRaw = env[DIFF_DISPLAY_MAX_LINES_ENV]
  return {
    diffOpenMaxLines:
      diffOpenMaxLinesRaw === undefined
        ? DEFAULT_UI_RENDER_CONFIG.diffOpenMaxLines
        : parsePositiveInt(DIFF_OPEN_MAX_LINES_ENV, diffOpenMaxLinesRaw),
    diffDisplayMaxLines:
      diffDisplayMaxLinesRaw === undefined
        ? DEFAULT_UI_RENDER_CONFIG.diffDisplayMaxLines
        : parsePositiveInt(DIFF_DISPLAY_MAX_LINES_ENV, diffDisplayMaxLinesRaw),
  }
}

export interface ReviewFacts {
  title: string
  files: string[]
  dependents: number
}

export interface ImpactDependent {
  specPath: string
  clauseId: string
  title: string
  stale: boolean
  evidenceVerdict: 'pass' | 'fail' | 'pending' | 'missing'
}

export interface ClauseNavigation {
  previous: ClauseTarget | null
  next: ClauseTarget | null
}

export interface SpecImpactView {
  schema: 'urtext.spec-impact/1'
  head: string | null
  target: ClauseTarget
  oracleKind: string | null
  oracleRef: string | null
  risk: 'low' | 'high'
  stale: boolean
  hasEvidence: boolean
  mappings: BriefMapping[]
  impact: Brief['impact']
  dependents: ImpactDependent[]
  navigation: ClauseNavigation
}

export interface BriefPageInput {
  text: string
  csrfToken: string
  key: string
  briefHash: string
  reviewable: boolean
  facts: ReviewFacts
  view: SpecImpactView
  config: UiRenderConfig
}
