import { expect, test } from 'vitest'

import * as urtext from '../src/index.js'

/**
 * Frozen baseline of the package `.` public export surface (I2 §Contract:
 * "preserve complete existing root export surface except intentional
 * renderPage removal/new exports"). The pre-I2 renderer cutover already
 * dropped `renderPage` in favor of `renderConsolePage`/`renderBriefPage`/
 * `renderBriefErrorPage` (I1) — this list is that post-cutover surface.
 * Any addition or removal here is an intentional, reviewed API change.
 */
const EXPECTED_EXPORTS = [
  'parseClauseFile',
  'baseline',
  'baselineValidation',
  'cluster',
  'distillCoverage',
  'discover',
  'l2IntentReview',
  'l2IntentReviewValidation',
  'promote',
  'runBaseline',
  'validateDistill',
  'ORACLE_KINDS',
  'parseTaskFile',
  'serializeTaskFile',
  'parseAnchorFields',
  'openRegistry',
  'indexClauseFile',
  'indexTaskFile',
  'tombstoneFile',
  'REGISTRY_SCHEMA',
  'discoverUnits',
  'scanWorkspace',
  'linkWorkspace',
  'propagateStale',
  'impact',
  'impactRequirement',
  'uncoveredRequirements',
  'runOracle',
  'verifyWorkspace',
  'ensureEvidenceLedger',
  'EVIDENCE_SCHEMA',
  'recordMapping',
  'recordAck',
  'detectUnmapped',
  'blame',
  'diffHunks',
  'ensureCodeMap',
  'CODE_MAP_SCHEMA',
  'exportRequest',
  'importVerdicts',
  'coverage',
  'latestEvidence',
  'ensureAuditLedger',
  'AUDIT_SCHEMA',
  'adjudicate',
  'recordReview',
  'reviewsAtHead',
  'listReviews',
  'currentHead',
  'worktreeDirty',
  'ensureReviewLedger',
  'REVIEW_SCHEMA',
  'recordDecision',
  'decisionsAtHead',
  'listDecisions',
  'ensureDecisionLedger',
  'DECISION_SCHEMA',
  'buildUiSnapshot',
  'handleDecide',
  'handleBrief',
  'buildSpecImpactView',
  'briefHistory',
  'renderConsolePage',
  'renderBriefPage',
  'renderBriefErrorPage',
  'readUiRenderConfig',
  'DEFAULT_UI_RENDER_CONFIG',
  'startUiServer',
  'buildStatus',
  'DEFAULT_WIP_LIMIT',
  'buildBrief',
  'currentBriefHash',
  'renderBriefText',
].sort()

test('root export surface matches the frozen baseline exactly', () => {
  const actual = Object.keys(urtext).sort()
  expect(actual).toEqual(EXPECTED_EXPORTS)
})

test('renderPage was intentionally removed in the I1 renderer cutover', () => {
  expect('renderPage' in urtext).toBe(false)
})

test('internal server implementation detail stays unexported', () => {
  expect('startUiServerWithDeps' in urtext).toBe(false)
})
