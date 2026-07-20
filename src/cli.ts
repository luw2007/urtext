#!/usr/bin/env node
/**
 * Urtext CLI — v0 surface:
 *
 *   urtext index          Scan specs/ and reconcile the clause registry.
 *   urtext check [--diff] Index, then report errors; exit 1 when any file is `building`
 *                         or any cross-file ref is unknown. `--diff` additionally
 *                         fails on unmapped working-tree changes (VISION P3).
 *   urtext status [--json] [--wip-limit <n>]
 *                         One item-keyed queue: human lane vs agent lane.
 *   urtext brief <spec-path>#<clause-id> | <file>:<line>[-<end>]
 *                         Full adjudication context + freshness hash (P2).
 *   urtext impact <spec-path>#<clause-id>
 *                         Reverse closure over the refs graph: affected clauses + tasks.
 *   urtext map <spec-path>#<clause-id> <file>:<start>-<end> [note…]
 *                         Record a diff-verified clause→code mapping (D4).
 *   urtext ack <file>:<start>-<end> <reason…>
 *                         Explicitly acknowledge an intentionally unmapped change.
 *   urtext blame <file>:<line>
 *                         Which clauses constrain this line.
 *   urtext audit --export | --import <file>
 *                         Cross-model meta-verification protocol (evidence coverage).
 *   urtext gate [--diff]  Risk-tier adjudication: which clauses auto-pass vs need a human.
 *   urtext --help | -h
 *
 * Registry lives at `.urtext/registry.sqlite` under the workspace root (cwd).
 * Git-native and serverless: no daemon, no workspace registration (VISION P8).
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import DatabaseConstructor from 'better-sqlite3'

import { coverage, exportRequest, importVerdicts, type AuditVerdictInput } from './audit.js'
import { buildBrief, renderBriefText, type BriefHistoryLine } from './brief.js'
import { blame, detectUnmapped, recordAck, recordMapping } from './dwarf.js'
import { listDecisions, recordDecision } from './decision.js'
import { adjudicate } from './gate.js'
import { impact } from './linker.js'
import { openRegistry } from './registry.js'
import { scanWorkspace } from './scanner.js'
import { buildStatus } from './status.js'
import { currentHead, listReviews, recordReview } from './review.js'
import { verifyWorkspace } from './verifier.js'
import { startUiServer } from './ui-server.js'

const USAGE = [
  'Usage:',
  '  urtext index     Scan specs/ and reconcile the clause registry.',
  '  urtext check [--diff]',
  '                   Index, then report errors; exit 1 on any building revision',
  '                   or unknown cross-file ref. --diff also fails on unmapped',
  '                   working-tree changes.',
  '  urtext verify    Index + check, then run every clause oracle and record evidence;',
  '                   exit 1 on any failing clause.',
  '  urtext status [--json] [--wip-limit <n>]',
  '                   One item-keyed queue: human lane (adjudications whose',
  '                   prerequisites are met, unmapped changes) + agent lane',
  '                   (remediable prerequisites). exit 1 when anything is pending.',
  '  urtext brief <spec-path>#<clause-id> | <file>:<line>[-<end>] [--json]',
  '                   Full adjudication context for a clause — text, mapped code,',
  '                   evidence, audit, impact — plus the brief-hash quoted back',
  '                   via `review`/`decide` --brief. Refuses building/link-broken',
  '                   revisions (no approvable hash, fail-closed).',
  '  urtext impact <spec-path>#<clause-id>',
  '                   List clauses and tasks affected if the clause changes.',
  '  urtext map <spec-path>#<clause-id> <file>:<start>-<end> [note…]',
  '                   Record a clause→code mapping, cross-verified against git diff.',
  '  urtext ack <file>:<start>-<end> <reason…>',
  '                   Acknowledge an intentionally unmapped change (reason required).',
  '  urtext blame <file>:<line>',
  '                   List the clauses constraining a code line.',
  '  urtext audit --export | --import <file>',
  '                   Meta-verification: export the evidence-coverage package for a',
  '                   different-preset auditor, or import its agree/disagree verdicts.',
  '  urtext gate [--diff]',
  '                   Risk-tier adjudication; --diff also counts unmapped changes.',
  '                   exit 1 when any clause needs a human.',
  '  urtext review <spec-path>#<clause-id> --approve|--reject [note…]',
  '                   Record a human code review for a high-risk clause (unsafe lane).',
  '  urtext decide <spec-path>#<clause-id> --pass|--fail [note…]',
  '                   Record a human decision for a manual-oracle clause (Decision ledger).',
  '  urtext decisions List the Decision ledger, newest first.',
  '  urtext ui [--port <n>] [--no-open]',
  '                   Open a local review panel to adjudicate manual clauses by',
  '                   click; writes the Decision ledger. Ctrl-C to quit.',
  '',
  'The registry lives at .urtext/registry.sqlite under the current directory.',
].join('\n')

/** Reviewer identity for the audit trail: URTEXT_REVIEWER, else git user, else $USER. */
const reviewerName = (): string => {
  const fromEnv = process.env.URTEXT_REVIEWER
  if (fromEnv) return fromEnv
  const gitUser = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' })
  const name = gitUser.status === 0 ? gitUser.stdout.trim() : ''
  return name || process.env.USER || 'unknown'
}

/** `<spec-path>#C<n>` → parts, or null. */
const parseClauseTarget = (target: string | undefined): { specPath: string; clauseId: string } | null => {
  const hash = target?.lastIndexOf('#') ?? -1
  if (!target || hash <= 0) return null
  const specPath = target.slice(0, hash)
  const clauseId = target.slice(hash + 1)
  return /^C\d+$/.test(clauseId) ? { specPath, clauseId } : null
}

/** `<file>:<start>-<end>` (or `<file>:<line>`) → parts, or null. */
const parseRangeTarget = (
  target: string | undefined
): { filePath: string; lineStart: number; lineEnd: number } | null => {
  const match = target?.match(/^(.+):(\d+)(?:-(\d+))?$/)
  if (!match || match[1] === undefined || match[2] === undefined) return null
  const lineStart = Number(match[2])
  const lineEnd = match[3] === undefined ? lineStart : Number(match[3])
  return lineStart >= 1 && lineEnd >= lineStart
    ? { filePath: match[1], lineStart, lineEnd }
    : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Validate a parsed audit file into verdict inputs without trusting its shape. */
const normalizeVerdicts = (parsed: unknown): AuditVerdictInput[] | null => {
  if (!isRecord(parsed) || !Array.isArray(parsed.verdicts)) return null
  const verdicts: AuditVerdictInput[] = []
  for (const item of parsed.verdicts) {
    if (!isRecord(item)) return null
    const { evidenceId, auditor, verdict, note } = item
    if (typeof evidenceId !== 'number' || !Number.isInteger(evidenceId)) return null
    if (typeof auditor !== 'string' || auditor.length === 0) return null
    if (verdict !== 'agree' && verdict !== 'disagree') return null
    if (note !== undefined && typeof note !== 'string') return null
    verdicts.push({ evidenceId, auditor, verdict, ...(note !== undefined ? { note } : {}) })
  }
  return verdicts
}

const openWorkspaceRegistry = (workspaceRoot: string) => {
  const dir = join(workspaceRoot, '.urtext')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseConstructor(join(dir, 'registry.sqlite'))
  db.pragma('journal_mode = WAL')
  openRegistry(db)
  return db
}

const run = (argv: string[]): number => {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command ? 0 : 1
  }

  const COMMANDS: Record<string, true> = {
    index: true,
    check: true,
    verify: true,
    status: true,
    brief: true,
    impact: true,
    map: true,
    ack: true,
    blame: true,
    audit: true,
    gate: true,
    review: true,
    decide: true,
    decisions: true,
  }
  if (COMMANDS[command] !== true) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`)
    return 1
  }

  const workspaceRoot = process.cwd()
  const db = openWorkspaceRegistry(workspaceRoot)
  try {
    if (command === 'audit') {
      const mode = argv[1]
      scanWorkspace(db, workspaceRoot)
      if (mode === '--export') {
        console.log(JSON.stringify(exportRequest(db), null, 2))
        return 0
      }
      if (mode === '--import') {
        const file = argv[2]
        if (!file) {
          console.error('Usage: urtext audit --import <file>')
          return 1
        }
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        const verdicts = normalizeVerdicts(parsed)
        if (verdicts === null) {
          console.error('Invalid audit file: expected {verdicts:[{evidenceId,auditor,verdict,note?}]}.')
          return 1
        }
        const outcome = importVerdicts(db, verdicts, Date.now())
        if (outcome.kind === 'rejected') {
          console.error(`[${outcome.code}] ${outcome.message}`)
          return 1
        }
        const report = coverage(db)
        const cov = report.coverage === null ? 'n/a' : `${Math.round(report.coverage * 100)}%`
        console.log(
          `imported ${outcome.count} verdict(s) — coverage ${cov} (${report.counts.agree} agree, ${report.counts.disagree} disagree, ${report.counts.unaudited} unaudited)`
        )
        return report.counts.disagree > 0 ? 1 : 0
      }
      console.error('Usage: urtext audit --export | --import <file>')
      return 1
    }

    if (command === 'gate') {
      scanWorkspace(db, workspaceRoot)
      let unmappedCount = 0
      if (argv.includes('--diff')) {
        const unmappedReport = detectUnmapped(db, workspaceRoot)
        if ('error' in unmappedReport) {
          console.error(unmappedReport.error)
          return 1
        }
        unmappedCount = unmappedReport.unmapped.length
      }
      const head = currentHead(workspaceRoot)
      const report = adjudicate(db, unmappedCount, head ?? undefined)
      if (argv.includes('--json')) {
        console.log(JSON.stringify({ schema: 'urtext.gate/1', head, ...report }, null, 2))
        return report.overall === 'auto-pass' ? 0 : 1
      }
      for (const decision of report.decisions) {
        const marker = decision.decision === 'auto-pass' ? '✓' : '⊗'
        const risk = decision.risk === 'high' ? ' [high]' : ''
        console.log(`  ${marker} ${decision.clauseId} ${decision.title}${risk} → ${decision.decision}`)
        for (const reason of decision.reasons) console.log(`      · ${reason}`)
      }
      console.log(`\noverall: ${report.overall}`)
      for (const reason of report.reasons) console.log(`  · ${reason}`)
      return report.overall === 'auto-pass' ? 0 : 1
    }

    if (command === 'status') {
      const wipFlag = argv.indexOf('--wip-limit')
      const wipLimit = wipFlag >= 0 ? Number(argv[wipFlag + 1]) : undefined
      if (wipLimit !== undefined && (!Number.isInteger(wipLimit) || wipLimit < 1)) {
        console.error('Usage: urtext status [--json] [--wip-limit <n>]')
        return 1
      }
      scanWorkspace(db, workspaceRoot)
      const unmappedReport = detectUnmapped(db, workspaceRoot)
      if ('error' in unmappedReport) {
        console.error(unmappedReport.error)
        return 1
      }
      const report = buildStatus(db, {
        head: currentHead(workspaceRoot),
        unmapped: unmappedReport.unmapped,
        ...(wipLimit !== undefined ? { wipLimit } : {}),
      })
      if (argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2))
        return report.items.length > 0 ? 1 : 0
      }
      const head = report.head ? report.head.slice(0, 7) : 'n/a'
      console.log(
        `status @ ${head} — ${report.counts.human} for you, ${report.counts.agent} for the agent, ${report.counts.autoPass} auto-pass`
      )
      const lanes = [
        { lane: 'human', label: 'your queue', marker: '⊗' },
        { lane: 'agent', label: 'agent lane', marker: '·' },
      ] as const
      for (const { lane, label, marker } of lanes) {
        const items = report.items.filter((item) => item.lane === lane)
        if (items.length === 0) continue
        console.log(`\n${label} (${items.length}):`)
        for (const item of items) {
          const risk = item.risk === 'high' ? ' [high]' : ''
          const title = item.title ? ` ${item.title}` : ''
          const secondary =
            item.reasons.length > 1 ? ` (+${item.reasons.slice(1).join(', ')})` : ''
          console.log(`  ${marker} ${item.key}${title}${risk} — ${item.primary}${secondary}`)
          console.log(`      next: ${item.next}`)
        }
      }
      if (report.wip.exceeded) {
        console.log(
          `\nwarning: human queue ${report.counts.human} exceeds wip limit ${report.wip.limit} — scrutiny degrades on large batches; consider smaller changes`
        )
      }
      if (report.items.length === 0) console.log('nothing pending — the gate should be green')
      return report.items.length > 0 ? 1 : 0
    }

    if (command === 'brief') {
      const target = argv[1]
      const clause = parseClauseTarget(target)
      const range = clause ? null : parseRangeTarget(target)
      if (!clause && !range) {
        console.error('Usage: urtext brief <spec-path>#<clause-id> | <file>:<line>[-<end>] [--json]')
        return 1
      }
      scanWorkspace(db, workspaceRoot)
      const targets: { specPath: string; clauseId: string }[] = []
      if (clause) targets.push(clause)
      else if (range) {
        for (const entry of blame(db, range.filePath, range.lineStart)) {
          if (!targets.some((t) => t.specPath === entry.specPath && t.clauseId === entry.clauseId)) {
            targets.push({ specPath: entry.specPath, clauseId: entry.clauseId })
          }
        }
        if (targets.length === 0) {
          console.error(
            `No clause constrains ${range.filePath}:${range.lineStart} — nothing to brief (try \`urtext blame\`).`
          )
          return 1
        }
      }
      const outcomes = targets.map((t) => buildBrief(db, workspaceRoot, t))
      if (argv.includes('--json')) {
        const payload = outcomes.map((outcome) =>
          outcome.kind === 'built'
            ? outcome.brief
            : { error: { code: outcome.code, message: outcome.message } }
        )
        console.log(JSON.stringify(clause ? payload[0] : payload, null, 2))
        return outcomes.some((outcome) => outcome.kind === 'refused') ? 1 : 0
      }
      let refused = false
      outcomes.forEach((outcome, index) => {
        if (index > 0) console.log('')
        if (outcome.kind === 'refused') {
          refused = true
          console.error(`[${outcome.code}] ${outcome.message}`)
          return
        }
        const { specPath, clauseId } = outcome.brief.manifest
        const history: BriefHistoryLine[] = [
          ...listReviews(db)
            .filter((record) => record.specPath === specPath && record.clauseId === clauseId)
            .map((record) => ({
              when: record.createdAt,
              what: `review ${record.decision} @ ${record.commitSha.slice(0, 7)} by ${record.reviewer}`,
              note: record.note,
            })),
          ...listDecisions(db)
            .filter((record) => record.specPath === specPath && record.clauseId === clauseId)
            .map((record) => ({
              when: record.createdAt,
              what: `decide ${record.verdict} @ ${record.commitSha.slice(0, 7)} by ${record.decider}`,
              note: record.note,
            })),
        ].sort((a, b) => b.when - a.when)
        console.log(renderBriefText(outcome.brief, history))
      })
      return refused ? 1 : 0
    }

    if (command === 'review') {
      const clause = parseClauseTarget(argv[1])
      const mode = argv[2]
      const decision = mode === '--approve' ? 'approve' : mode === '--reject' ? 'reject' : null
      const note = argv.slice(3).join(' ')
      if (!clause || decision === null) {
        console.error('Usage: urtext review <spec-path>#<clause-id> --approve|--reject [note…]')
        return 1
      }
      scanWorkspace(db, workspaceRoot)
      const outcome = recordReview(
        db,
        { ...clause, decision, reviewer: reviewerName(), ...(note ? { note } : {}) },
        workspaceRoot,
        Date.now()
      )
      if (outcome.kind === 'rejected') {
        console.error(`[${outcome.code}] ${outcome.message}`)
        return 1
      }
      console.log(
        `${decision === 'approve' ? 'approved' : 'rejected'} ${clause.specPath}#${clause.clauseId} @ ${outcome.commitSha.slice(0, 7)} by ${reviewerName()}`
      )
      return 0
    }

    if (command === 'decide') {
      const clause = parseClauseTarget(argv[1])
      const mode = argv[2]
      const verdict = mode === '--pass' ? 'pass' : mode === '--fail' ? 'fail' : null
      const note = argv.slice(3).join(' ')
      if (!clause || verdict === null) {
        console.error('Usage: urtext decide <spec-path>#<clause-id> --pass|--fail [note…]')
        return 1
      }
      scanWorkspace(db, workspaceRoot)
      const outcome = recordDecision(
        db,
        { ...clause, verdict, decider: reviewerName(), ...(note ? { note } : {}) },
        workspaceRoot,
        Date.now()
      )
      if (outcome.kind === 'rejected') {
        console.error(`[${outcome.code}] ${outcome.message}`)
        return 1
      }
      console.log(
        `decided ${clause.specPath}#${clause.clauseId} → ${verdict} @ ${outcome.commitSha.slice(0, 7)} by ${reviewerName()}`
      )
      return 0
    }

    if (command === 'decisions') {
      const records = listDecisions(db)
      if (records.length === 0) {
        console.log('No decisions recorded.')
        return 0
      }
      for (const record of records) {
        const when = new Date(record.createdAt).toISOString().slice(0, 19).replace('T', ' ')
        const note = record.note ? ` — ${record.note}` : ''
        console.log(
          `  ${when} ${record.specPath}#${record.clauseId} → ${record.verdict} @ ${record.commitSha.slice(0, 7)} by ${record.decider}${note}`
        )
      }
      return 0
    }

    if (command === 'map') {
      const clause = parseClauseTarget(argv[1])
      const range = parseRangeTarget(argv[2])
      if (!clause || !range) {
        console.error('Usage: urtext map <spec-path>#<clause-id> <file>:<start>-<end> [note…]')
        return 1
      }
      scanWorkspace(db, workspaceRoot)
      const note = argv.slice(3).join(' ')
      const outcome = recordMapping(
        db,
        { ...clause, ...range, ...(note ? { note } : {}) },
        workspaceRoot,
        Date.now()
      )
      if (outcome.kind === 'rejected') {
        console.error(`[${outcome.code}] ${outcome.message}`)
        return 1
      }
      console.log(
        `mapped ${clause.specPath}#${clause.clauseId} → ${range.filePath}:${range.lineStart}-${range.lineEnd} @ ${outcome.commitSha.slice(0, 7)}`
      )
      return 0
    }

    if (command === 'ack') {
      const range = parseRangeTarget(argv[1])
      const note = argv.slice(2).join(' ')
      if (!range || !note) {
        console.error('Usage: urtext ack <file>:<start>-<end> <reason…> (reason is required)')
        return 1
      }
      const outcome = recordAck(db, { ...range, note }, workspaceRoot, Date.now())
      if (outcome.kind === 'rejected') {
        console.error(`[${outcome.code}] ${outcome.message}`)
        return 1
      }
      console.log(
        `acked ${range.filePath}:${range.lineStart}-${range.lineEnd} @ ${outcome.commitSha.slice(0, 7)} — ${note}`
      )
      return 0
    }

    if (command === 'blame') {
      const range = parseRangeTarget(argv[1])
      if (!range) {
        console.error('Usage: urtext blame <file>:<line>')
        return 1
      }
      const entries = blame(db, range.filePath, range.lineStart)
      if (entries.length === 0) {
        console.log(`No clause constrains ${range.filePath}:${range.lineStart}.`)
        return 0
      }
      for (const entry of entries) {
        const note = entry.note ? ` — ${entry.note}` : ''
        console.log(
          `  ${entry.specPath}#${entry.clauseId} (${entry.lineStart}-${entry.lineEnd} @ ${entry.commitSha.slice(0, 7)})${note}`
        )
      }
      return 0
    }

    if (command === 'impact') {
      const clause = parseClauseTarget(argv[1])
      if (!clause) {
        console.error(`Usage: urtext impact <spec-path>#<clause-id>\n\nGot: ${argv[1] ?? '(nothing)'}`)
        return 1
      }
      const { specPath, clauseId } = clause
      scanWorkspace(db, workspaceRoot)
      const report = impact(db, { specPath, clauseId })
      if (report.affectedClauses.length === 0 && report.affectedTasks.length === 0) {
        console.log(`No clause refs ${specPath}#${clauseId} and no task cites it.`)
        return 0
      }
      if (report.affectedClauses.length > 0) {
        console.log('Affected clauses (reverse closure):')
        for (const clause of report.affectedClauses) {
          console.log(`  ${clause.specPath}#${clause.clauseId}`)
        }
      }
      if (report.affectedTasks.length > 0) {
        console.log('Affected tasks:')
        for (const task of report.affectedTasks) {
          console.log(`  ${task.specPath} ${task.fileId} ${task.title} (cites ${task.clauseId})`)
        }
      }
      return 0
    }

    const report = scanWorkspace(db, workspaceRoot)
    const jsonMode = command === 'check' && argv.includes('--json')
    if (report.units.length === 0) {
      if (jsonMode) {
        console.log(
          JSON.stringify(
            { schema: 'urtext.check/1', failures: 0, building: [], linkErrors: [], stale: report.stale, unmapped: [] },
            null,
            2
          )
        )
        return 0
      }
      console.log('No feature units found under specs/.')
      return 0
    }

    let buildingCount = 0
    const building: {
      specPath: string
      revision: number
      errors: { line: number; code: string; message: string }[]
    }[] = []
    for (const { specPath, outcome } of report.outcomes) {
      if (outcome.kind === 'unchanged') {
        if (!jsonMode) console.log(`  = ${specPath} (rev ${outcome.revision}, unchanged)`)
        continue
      }
      if (outcome.kind === 'tombstoned') {
        if (!jsonMode) console.log(`  - ${specPath} (rev ${outcome.revision}, tombstoned)`)
        continue
      }
      const marker = outcome.status === 'ready' ? '✓' : '✗'
      if (!jsonMode) console.log(`  ${marker} ${specPath} (rev ${outcome.revision}, ${outcome.status})`)
      if (outcome.status === 'building') {
        buildingCount++
        building.push({
          specPath,
          revision: outcome.revision,
          errors: outcome.errors.map((error) => ({
            line: error.line + 1,
            code: error.code,
            message: error.message,
          })),
        })
        if (!jsonMode) {
          for (const error of outcome.errors) {
            console.log(`      line ${error.line + 1}: [${error.code}] ${error.message}`)
          }
        }
      }
    }

    if (!jsonMode) {
      for (const error of report.linkErrors) {
        console.log(
          `  ✗ ${error.specPath} line ${error.line + 1}: [${error.code}] ${error.message}`
        )
      }
      if (report.stale.staleClauses.length > 0) {
        const list = report.stale.staleClauses
          .map((clause) => `${clause.specPath}#${clause.clauseId}`)
          .join(', ')
        console.log(
          `  ~ stale: ${list} (${report.stale.invalidatedEvidence} evidence row(s) invalidated)`
        )
      }
    }

    let failures = buildingCount + report.linkErrors.length

    // check --diff: unmapped working-tree changes are a validation failure
    // (VISION P3 — source-of-truth flip is enforced, not prompt-disciplined).
    let unmappedHunks: { filePath: string; lineStart: number; lineEnd: number }[] = []
    if (command === 'check' && argv.includes('--diff')) {
      const unmappedReport = detectUnmapped(db, workspaceRoot)
      if ('error' in unmappedReport) {
        if (jsonMode) {
          console.log(JSON.stringify({ schema: 'urtext.check/1', error: unmappedReport.error }, null, 2))
          return 1
        }
        console.error(`\n${unmappedReport.error}`)
        return 1
      }
      unmappedHunks = unmappedReport.unmapped
      if (!jsonMode) {
        for (const hunk of unmappedReport.unmapped) {
          console.log(
            `  ⚠ unmapped ${hunk.filePath}:${hunk.lineStart}-${hunk.lineEnd} — map to a clause, ack, or write back to spec`
          )
        }
      }
      failures += unmappedReport.unmapped.length
    }

    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            schema: 'urtext.check/1',
            failures,
            building,
            linkErrors: report.linkErrors.map((error) => ({
              specPath: error.specPath,
              clauseId: error.clauseId,
              line: error.line + 1,
              code: error.code,
              message: error.message,
            })),
            stale: report.stale,
            unmapped: unmappedHunks,
          },
          null,
          2
        )
      )
      return failures > 0 ? 1 : 0
    }

    if (command !== 'index' && failures > 0) {
      console.error(`\n${failures} validation failure(s).`)
      return 1
    }
    if (command !== 'verify') return 0

    // verify: run every clause oracle against the latest ready revisions.
    const verifyReport = verifyWorkspace(db, workspaceRoot)
    if (verifyReport.verdicts.length === 0) {
      console.log('\nNo clauses to verify.')
      return 0
    }
    console.log('')
    for (const verdict of verifyReport.verdicts) {
      const marker =
        verdict.verdict === 'pass' ? '✓' : verdict.verdict === 'pending' ? '?' : '✗'
      const risk = verdict.risk === 'high' ? ' [high]' : ''
      console.log(
        `  ${marker} ${verdict.clauseId} ${verdict.title}${risk} (${verdict.oracleKind}, ${verdict.verdict})`
      )
      if (verdict.verdict === 'fail') {
        for (const line of verdict.output.split('\n').slice(0, 6)) {
          console.log(`      ${line}`)
        }
      }
    }
    const { counts, passRate, manualShare } = verifyReport
    const rate = passRate === null ? 'n/a' : `${Math.round(passRate * 100)}%`
    const manual = manualShare === null ? 'n/a' : `${Math.round(manualShare * 100)}%`
    console.log(
      `\n${counts.pass} pass, ${counts.fail} fail, ${counts.pending} pending — pass rate ${rate}, manual share ${manual}`
    )
    if (manualShare !== null && manualShare > 0.5) {
      console.log('warning: manual oracle share exceeds 50% — the load-bearing assumption is failing (VISION P9)')
    }
    return counts.fail > 0 ? 1 : 0
  } finally {
    db.close()
  }
}

/** `ui` is long-running and owns its db for the whole session, so it lives
 * outside the synchronous `run` (which closes the db in a finally). */
const runUi = async (argv: string[]): Promise<number> => {
  const root = process.cwd()
  const portFlag = argv.indexOf('--port')
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : undefined
  if (port !== undefined && !Number.isInteger(port)) {
    console.error('Usage: urtext ui [--port <n>] [--no-open]')
    return 1
  }
  const db = openWorkspaceRegistry(root)
  scanWorkspace(db, root)
  const handle = await startUiServer(db, root, {
    ...(port !== undefined ? { port } : {}),
    open: !argv.includes('--no-open'),
    decider: reviewerName(),
  })
  console.log(`review: ${handle.url}  (Ctrl-C to quit)`)
  const { promise } = Promise.withResolvers<number>()
  process.on('SIGINT', () => {
    handle.close()
    db.close()
    process.exit(0)
  })
  return promise
}

if (process.argv[2] === 'ui') {
  runUi(process.argv.slice(3)).then((code) => process.exit(code))
} else {
  process.exit(run(process.argv.slice(2)))
}
