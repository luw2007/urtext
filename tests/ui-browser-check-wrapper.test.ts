import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { buildChromeArgs, parseDevToolsActivePort } from '../scripts/ui-browser-check-wrapper.mjs'

const scratchDirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'urtext-wrapper-test-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('buildChromeArgs', () => {
  test('binds the isolated profile dir and OS-assigned loopback CDP port', () => {
    const args = buildChromeArgs('/tmp/profile-xyz')
    expect(args).toContain('--user-data-dir=/tmp/profile-xyz')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--headless=new')
  })

  test('never requests a fixed/well-known debug port', () => {
    const args = buildChromeArgs('/tmp/x')
    expect(args.some((a) => /^--remote-debugging-port=(?!0$)\d+$/.test(a))).toBe(false)
  })
})

describe('parseDevToolsActivePort', () => {
  test('parses the real port and browser path Chrome writes', () => {
    expect(parseDevToolsActivePort('54321\n/devtools/browser/abc-123\n')).toEqual({
      port: 54321,
      browserPath: '/devtools/browser/abc-123',
    })
  })

  test('rejects a non-numeric or non-positive port', () => {
    expect(() => parseDevToolsActivePort('not-a-port\n/x\n')).toThrow(/malformed DevToolsActivePort/)
    expect(() => parseDevToolsActivePort('0\n/x\n')).toThrow(/malformed DevToolsActivePort/)
    expect(() => parseDevToolsActivePort('-1\n/x\n')).toThrow(/malformed DevToolsActivePort/)
  })
})

describe('wrapper usage contract', () => {
  test('documents the checker mandatory contrast manifest and source root flags', () => {
    const path = join(__dirname, '..', 'scripts', 'ui-browser-check-wrapper.mjs')
    const result = spawnSync(process.execPath, [path], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--contrast-manifest <path>')
    expect(result.stderr).toContain('--source-root <repo>')
  })
})

describe('wrapper script executable bit', () => {
  test('is marked executable so it can be invoked directly', () => {
    const path = join(__dirname, '..', 'scripts', 'ui-browser-check-wrapper.mjs')
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o100).not.toBe(0)
  })
})

describe('DevToolsActivePort round trip against a real fixture file', () => {
  test('reads the exact bytes Chrome would write', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/fixture\n')
    const { port, browserPath } = parseDevToolsActivePort(
      readFileSync(join(dir, 'DevToolsActivePort'), 'utf8'),
    )
    expect(port).toBe(9222)
    expect(browserPath).toBe('/devtools/browser/fixture')
  })
})
