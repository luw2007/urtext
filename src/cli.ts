#!/usr/bin/env node
/**
 * Urtext CLI — v0 surface:
 *
 *   urtext index          Scan specs/ and reconcile the clause registry.
 *   urtext check          Index, then report errors; exit 1 when any file is `building`
 *                         or any cross-file ref is unknown.
 *   urtext impact <spec-path>#<clause-id>
 *                         Reverse closure over the refs graph: affected clauses + tasks.
 *   urtext --help | -h
 *
 * Registry lives at `.urtext/registry.sqlite` under the workspace root (cwd).
 * Git-native and serverless: no daemon, no workspace registration (VISION P8).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import DatabaseConstructor from 'better-sqlite3'

import { impact } from './linker.js'
import { openRegistry } from './registry.js'
import { scanWorkspace } from './scanner.js'
import { verifyWorkspace } from './verifier.js'

const USAGE = [
  'Usage:',
  '  urtext index     Scan specs/ and reconcile the clause registry.',
  '  urtext check     Index, then report errors; exit 1 on any building revision',
  '                   or unknown cross-file ref.',
  '  urtext verify    Index + check, then run every clause oracle and record evidence;',
  '                   exit 1 on any failing clause.',
  '  urtext impact <spec-path>#<clause-id>',
  '                   List clauses and tasks affected if the clause changes.',
  '',
  'The registry lives at .urtext/registry.sqlite under the current directory.',
].join('\n')

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

  const COMMANDS: Record<string, true> = { index: true, check: true, verify: true, impact: true }
  if (COMMANDS[command] !== true) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`)
    return 1
  }

  const workspaceRoot = process.cwd()
  const db = openWorkspaceRegistry(workspaceRoot)
  try {
    if (command === 'impact') {
      const target = argv[1]
      const hash = target?.lastIndexOf('#') ?? -1
      const specPath = hash > 0 && target ? target.slice(0, hash) : ''
      const clauseId = hash > 0 && target ? target.slice(hash + 1) : ''
      if (!specPath || !/^C\d+$/.test(clauseId)) {
        console.error(`Usage: urtext impact <spec-path>#<clause-id>\n\nGot: ${target ?? '(nothing)'}`)
        return 1
      }
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
    if (report.units.length === 0) {
      console.log('No feature units found under specs/.')
      return 0
    }

    let buildingCount = 0
    for (const { specPath, outcome } of report.outcomes) {
      if (outcome.kind === 'unchanged') {
        console.log(`  = ${specPath} (rev ${outcome.revision}, unchanged)`)
        continue
      }
      if (outcome.kind === 'tombstoned') {
        console.log(`  - ${specPath} (rev ${outcome.revision}, tombstoned)`)
        continue
      }
      const marker = outcome.status === 'ready' ? '✓' : '✗'
      console.log(`  ${marker} ${specPath} (rev ${outcome.revision}, ${outcome.status})`)
      if (outcome.status === 'building') {
        buildingCount++
        for (const error of outcome.errors) {
          console.log(`      line ${error.line + 1}: [${error.code}] ${error.message}`)
        }
      }
    }

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

    const failures = buildingCount + report.linkErrors.length
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

process.exit(run(process.argv.slice(2)))
