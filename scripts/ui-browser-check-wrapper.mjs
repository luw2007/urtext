#!/usr/bin/env node
/**
 * I3 Chrome launch wrapper (urtext-20260724-ui-redesign §7.2 I3, §8.3.2).
 *
 * Launches a single headless Chrome with an isolated, freshly-created
 * profile directory and remote-debugging-port=0 (OS-assigned), reads the
 * resulting `DevToolsActivePort` file to recover the real port, then execs
 * the compiled `ui-browser-check.js` with that port and profile passed
 * explicitly — `ui-browser-check.js` never launches or discovers Chrome on
 * its own. Plain `.mjs`: no build step, no dependency on this repo's `dist/`
 * layout to run the wrapper itself.
 *
 * Usage:
 *   node scripts/ui-browser-check-wrapper.mjs --chrome <path> --check <compiled-check.js> --contrast-manifest <path> --source-root <repo> --page <name>=<url> [--page <name>=<url> ...]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Chrome flags fixed by §8.3.2 item 5: headless, loopback CDP on an OS-assigned port, isolated profile, no first-run/default-browser/background-networking noise. */
export const buildChromeArgs = (profileDir) => [
  '--headless=new',
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-extensions',
  '--host-resolver-rules=MAP * 127.0.0.1',
]

/** Parses the `<profileDir>/DevToolsActivePort` file (`<port>\n<path>`) Chrome writes once its debug listener is up. Throws on malformed content. */
export const parseDevToolsActivePort = (fileContents) => {
  const lines = fileContents.split('\n')
  const portLine = lines[0]
  const pathLine = lines[1] ?? '/'
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`malformed DevToolsActivePort file: bad port ${JSON.stringify(portLine)}`)
  }
  return { port, browserPath: pathLine }
}

const readArg = (args, flag) => {
  const idx = args.indexOf(flag)
  return idx === -1 ? undefined : args[idx + 1]
}

/** Polls for `<profileDir>/DevToolsActivePort` up to `timeoutMs`, then returns its parsed content. */
export const waitForDevToolsActivePort = async (profileDir, timeoutMs = 10_000) => {
  const path = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return parseDevToolsActivePort(readFileSync(path, 'utf8'))
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`DevToolsActivePort not ready after ${timeoutMs}ms: ${String(err)}`)
      const sleep = Promise.withResolvers()
      setTimeout(sleep.resolve, 100)
      await sleep.promise
    }
  }
}

const waitForExit = (child, timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      reject(new Error(`Chrome did not exit after ${timeoutMs}ms`))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

export const stopChromeAndRemoveProfile = async (chrome, profileDir) => {
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM')
  try {
    await waitForExit(chrome, 5_000)
  } catch {
    chrome.kill('SIGKILL')
    await waitForExit(chrome, 5_000)
  }
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

const isMain = () => {
  const arg1 = process.argv[1]
  return arg1 !== undefined && import.meta.url.endsWith(arg1.split('/').pop() ?? '\0')
}

if (isMain()) {
  const args = process.argv.slice(2)
  const chromePath = readArg(args, '--chrome')
  const checkPath = readArg(args, '--check')
  if (chromePath === undefined || checkPath === undefined) {
    process.stderr.write(
      'usage: ui-browser-check-wrapper.mjs --chrome <path> --check <compiled-ui-browser-check.js> --contrast-manifest <path> --source-root <repo> --page <name>=<url> [--page <name>=<url> ...] [--output-dir <dir>] [--focus-steps <n>] [--diff-count <n>] [--disclosure <id>=<true|false>]\n',
    )
    process.exit(2)
  }
  const forwardedArgs = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--chrome' || args[i] === '--check') {
      i += 1
      continue
    }
    forwardedArgs.push(args[i])
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'urtext-chrome-profile-'))
  const chrome = spawn(chromePath, buildChromeArgs(profileDir), { stdio: 'ignore' })

  let exitCode = 1
  try {
    const { port } = await waitForDevToolsActivePort(profileDir)
    const check = spawn(
      process.execPath,
      [checkPath, '--port', String(port), '--profile', profileDir, ...forwardedArgs],
      { stdio: 'inherit' },
    )
    const exited = Promise.withResolvers()
    check.on('exit', (code) => exited.resolve(code ?? 1))
    exitCode = await exited.promise
  } finally {
    await stopChromeAndRemoveProfile(chrome, profileDir)
  }
  process.exit(exitCode)
}
