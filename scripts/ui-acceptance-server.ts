#!/usr/bin/env node
/**
 * S4 compiled acceptance-only internal server helper (urtext-20260724-ui-redesign
 * §§8.2 item 8, 8.3.2-8.3.5, 9.1). Never part of `dist/` or the public package —
 * deep-imports `startUiServerWithDeps` from inside this repository's source/build
 * tree only, exactly as `tests/ui-server.test.ts` does.
 *
 * Invoked as `node ui-acceptance-server.js --root <fixture-root>` against a root
 * already built by the compiled `ui-acceptance-fixture.js` entry. Opens that
 * fixture's registry, builds a local agent-stub wrapper bundle rooted at
 * `<root>/.urtext/ui-agent-stubs/` (its own compiled sibling `ui-agent-stub.js`
 * is the stub helper the wrappers exec), and starts the internal server on
 * port 0 with `open: false`, `decider: 'ui-acceptance'`, `pageSize: 2` (small
 * enough that the fixture's 5-clause `/specs` route exercises real pagination).
 * `spawnAsync` never touches a real agent CLI or network — it routes the exact
 * command name (`claude`/`codex`/`traecli`/`omp`) an `AuditorId` resolves to
 * onto the matching local wrapper, inferring audit-vs-explain mode from the
 * real caller's own argv shape (`--json-schema`/`--output-schema`/`--mode` only
 * ever appear on the audit path — see `src/audit-runner.ts` `commandFor` vs
 * `textCommandFor`).
 *
 * Every request emits one redacted `AcceptanceRequestRecord` (via `onRequest`)
 * and every stub spawn emits one redacted shape-only record (command/mode/pid —
 * never argv, prompt, or CSRF bytes). Prints exactly one readiness JSON line
 * once listening, and exactly one final sanitized-result JSON line on SIGINT
 * or an IPC `"shutdown"` message, then exits 0 after closing the server, the
 * db handle, and releasing the port.
 */
import { spawn as realSpawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import DatabaseConstructor from 'better-sqlite3'

import { openRegistry } from '../src/index.js'
import { startUiServerWithDeps, type AcceptanceRequestRecord } from '../src/ui-server.js'
import type { AsyncSpawn } from '../src/audit-runner.js'
import { createAgentStubBundle } from './ui-acceptance-fixture.js'
import { isTransport, type Mode } from './ui-agent-stub.js'

/** Redacted shape-only stub-invocation record — never the forwarded argv. */
interface StubInvocationRecord {
  command: string
  mode: Mode
  pid: number | null
}

const readArg = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}

/** Audit invocations always carry a JSON-schema arg (`--json-schema` for
 * claude, `--output-schema` for codex/traecli, `--mode json` for omp);
 * explain invocations never do (`src/audit-runner.ts` `commandFor` vs
 * `textCommandFor`). */
const isAuditArgs = (args: readonly string[]): boolean =>
  args.includes('--json-schema') || args.includes('--output-schema') || args.includes('--mode')

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const root = readArg(args, '--root')
  if (root === undefined) {
    process.stderr.write('ui-acceptance-server: --root <fixture-root> is required\n')
    process.exitCode = 2
    return
  }

  const db = new DatabaseConstructor(join(root, '.urtext/registry.sqlite'))
  openRegistry(db)

  const stubEntry = join(dirname(fileURLToPath(import.meta.url)), 'ui-agent-stub.js')
  const bundle = createAgentStubBundle(root, stubEntry)

  const requestRecords: AcceptanceRequestRecord[] = []
  const stubRecords: StubInvocationRecord[] = []

  const stubSpawnAsync: AsyncSpawn = ((command: string, cliArgs: readonly string[] = [], options: unknown) => {
    if (!isTransport(command)) throw new Error(`ui-acceptance-server: no stub wrapper for command ${command}`)
    const wrapperPath = bundle.wrappers[command]
    const mode: Mode = isAuditArgs(cliArgs) ? 'audit' : 'explain'
    const child = realSpawn(wrapperPath, ['--mode', mode], {
      ...(typeof options === 'object' && options !== null ? options : {}),
      env: { ...process.env, HOME: bundle.homeDir, URTEXT_STUB_LOG: bundle.logPath },
    })
    stubRecords.push({ command, mode, pid: child.pid ?? null })
    return child
  }) as AsyncSpawn

  const handle = await startUiServerWithDeps(db, root, {
    port: 0,
    open: false,
    decider: 'ui-acceptance',
    pageSize: 2,
    agentDeps: { spawnAsync: stubSpawnAsync },
    onRequest: (record) => {
      requestRecords.push(record)
    },
  })

  process.stdout.write(`${JSON.stringify({ schema: 'urtext.ui-acceptance-server.ready/1', url: handle.url })}\n`)

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    handle.close()
    db.close()
    process.stdout.write(
      `${JSON.stringify({
        schema: 'urtext.ui-acceptance-server.result/1',
        requests: requestRecords,
        stubs: stubRecords,
      })}\n`
    )
    process.exitCode = 0
  }

  process.once('SIGINT', shutdown)
  process.on('message', (message: unknown) => {
    if (message === 'shutdown') shutdown()
  })
}

void main()
