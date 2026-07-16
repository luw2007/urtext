#!/usr/bin/env node
/**
 * Urtext CLI — v0 surface:
 *
 *   urtext index          Scan specs/ and reconcile the clause registry.
 *   urtext check          Index, then report errors; exit 1 when any file is `building`.
 *   urtext --help | -h
 *
 * Registry lives at `.urtext/registry.sqlite` under the workspace root (cwd).
 * Git-native and serverless: no daemon, no workspace registration (VISION P8).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import DatabaseConstructor from 'better-sqlite3'

import { openRegistry } from './registry.js'
import { scanWorkspace } from './scanner.js'
import { verifyWorkspace } from './verifier.js'

const USAGE = [
  'Usage:',
  '  urtext index     Scan specs/ and reconcile the clause registry.',
  '  urtext check     Index, then report errors; exit 1 on any building revision.',
  '  urtext verify    Index + check, then run every clause oracle and record evidence;',
  '                   exit 1 on any failing clause.',
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

  if (command !== 'index' && command !== 'check' && command !== 'verify') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`)
    return 1
  }

  const workspaceRoot = process.cwd()
  const db = openWorkspaceRegistry(workspaceRoot)
  try {
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

    if (command !== 'index' && buildingCount > 0) {
      console.error(`\n${buildingCount} file(s) failed validation.`)
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
