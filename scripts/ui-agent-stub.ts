#!/usr/bin/env node
/**
 * S4 local agent stub helper (urtext-20260724-ui-redesign §8.2 item 8-9).
 *
 * Invoked by the `<root>/.urtext/ui-agent-stubs/bin/{claude,codex,traecli,omp}`
 * POSIX wrappers the fixture generates. Never talks to a network or a real
 * model: it prints a fixed, deterministic audit/explain result for its
 * transport + mode pair (4 transports × 2 modes = 8 combinations) and appends
 * one redacted shape-only line to an external log sink — no raw argv, prompt,
 * or credential content is ever persisted or echoed. `URTEXT_STUB_DELAY_MS`
 * (default 0; acceptance sets 750) lets callers exercise a slow-agent path
 * without a real timeout.
 */
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const TRANSPORTS = ['claude', 'codex', 'traecli', 'omp'] as const
export type Transport = (typeof TRANSPORTS)[number]

export const MODES = ['audit', 'explain'] as const
export type Mode = (typeof MODES)[number]

export const isTransport = (value: string): value is Transport =>
  (TRANSPORTS as readonly string[]).includes(value)

export const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value)

/** Fixed, deterministic output per (transport, mode) — the 8 stub modes. */
export const FIXED_OUTPUT: Record<Transport, Record<Mode, unknown>> = {
  claude: {
    audit: { verdict: 'agree', note: 'stub claude audit: evidence covers clause' },
    explain: { explanation: 'stub claude explanation: approving locks in the current mapped diff.' },
  },
  codex: {
    audit: { verdict: 'agree', note: 'stub codex audit: evidence covers clause' },
    explain: { explanation: 'stub codex explanation: rejecting requires a documented reason.' },
  },
  traecli: {
    audit: { verdict: 'disagree', note: 'stub traecli audit: oracle too weak for this clause' },
    explain: { explanation: 'stub traecli explanation: approval binds the current brief hash.' },
  },
  omp: {
    audit: { verdict: 'agree', note: 'stub omp audit: evidence covers clause' },
    explain: { explanation: 'stub omp explanation: this clause has no downstream dependents.' },
  },
}

const readArg = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}

/** Redacted invocation record — shape only, never the forwarded argv/prompt bytes. */
interface StubLogEntry {
  ts: number
  transport: Transport
  mode: Mode
  wrapperRealpath: string | null
  argvCount: number
  delayedMs: number
  pid: number
}

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const transportRaw = readArg(args, '--transport')
  const stubRealpath = readArg(args, '--stub-realpath')
  const modeRaw = readArg(args, '--mode')

  if (transportRaw === undefined || !isTransport(transportRaw)) {
    process.stderr.write(`ui-agent-stub: unknown --transport ${String(transportRaw)}\n`)
    process.exitCode = 2
    return
  }
  if (modeRaw === undefined || !isMode(modeRaw)) {
    process.stderr.write(`ui-agent-stub: unknown --mode ${String(modeRaw)}\n`)
    process.exitCode = 2
    return
  }
  const transport: Transport = transportRaw
  const mode: Mode = modeRaw

  const delayRaw = process.env.URTEXT_STUB_DELAY_MS
  const delayMs = delayRaw !== undefined && /^\d+$/.test(delayRaw) ? Number(delayRaw) : 0
  if (delayMs > 0) await delay(delayMs)

  const logSink = process.env.URTEXT_STUB_LOG
  if (logSink) {
    const entry: StubLogEntry = {
      ts: Date.now(),
      transport,
      mode,
      wrapperRealpath: stubRealpath ?? null,
      argvCount: args.length,
      delayedMs: delayMs,
      pid: process.pid,
    }
    appendFileSync(logSink, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  process.stdout.write(`${JSON.stringify(FIXED_OUTPUT[transport][mode])}\n`)
}

const isMain = (): boolean =>
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain()) {
  void main()
}
