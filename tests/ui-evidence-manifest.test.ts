import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertNoSelfReference,
  assertSixTools,
  buildManifest,
  buildPayloadInventory,
  computeManifestDigest,
  DIGEST_FILENAME,
  MANIFEST_FILENAME,
  SIX_TOOL_NAMES,
  sha256Hex,
  verifyManifestDigest,
  writeManifest,
  type PayloadEntry,
  type ToolPreflightEntry,
} from '../scripts/ui-evidence-manifest.js'

const scratchDirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'urtext-evidence-manifest-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sixTools = (): ToolPreflightEntry[] =>
  SIX_TOOL_NAMES.map((name) => ({ name, realpath: `/usr/bin/${name}`, version: '1.0.0' }))

describe('SIX_TOOL_NAMES', () => {
  test('is exactly the six approved platform tools', () => {
    expect(SIX_TOOL_NAMES).toEqual(['node', 'git', 'npm', 'bun', 'cmux', 'chrome'])
  })
})

describe('assertSixTools', () => {
  test('accepts exactly six unique, absolute, versioned entries', () => {
    expect(() => assertSixTools(sixTools())).not.toThrow()
  })

  test('rejects fewer than six tools', () => {
    expect(() => assertSixTools(sixTools().slice(0, 5))).toThrow(/expected exactly 6/)
  })

  test('rejects a duplicate tool name', () => {
    const tools = sixTools()
    tools[5] = { ...tools[0]! }
    expect(() => assertSixTools(tools)).toThrow(/duplicate preflight tool/)
  })

  test('rejects a relative realpath', () => {
    const tools = sixTools()
    tools[0] = { ...tools[0]!, realpath: 'bin/node' }
    expect(() => assertSixTools(tools)).toThrow(/realpath must be absolute/)
  })

  test('rejects an empty version', () => {
    const tools = sixTools()
    tools[0] = { ...tools[0]!, version: '  ' }
    expect(() => assertSixTools(tools)).toThrow(/version must be non-empty/)
  })
})

describe('assertNoSelfReference', () => {
  test('rejects the manifest filename in its own payload inventory', () => {
    const entries: PayloadEntry[] = [{ path: MANIFEST_FILENAME, bytes: 1, sha256: 'a'.repeat(64) }]
    expect(() => assertNoSelfReference(entries)).toThrow(/self-reference/)
  })

  test('rejects the digest sidecar filename in the payload inventory', () => {
    const entries: PayloadEntry[] = [{ path: DIGEST_FILENAME, bytes: 1, sha256: 'a'.repeat(64) }]
    expect(() => assertNoSelfReference(entries)).toThrow(/self-reference/)
  })

  test('rejects duplicate payload paths', () => {
    const entries: PayloadEntry[] = [
      { path: 'cmux-transcript.json', bytes: 1, sha256: 'a'.repeat(64) },
      { path: 'cmux-transcript.json', bytes: 2, sha256: 'b'.repeat(64) },
    ]
    expect(() => assertNoSelfReference(entries)).toThrow(/duplicate payload path/)
  })

  test('accepts a payload inventory with no self-reference', () => {
    const entries: PayloadEntry[] = [{ path: 'cdp-ledger.json', bytes: 1, sha256: 'a'.repeat(64) }]
    expect(() => assertNoSelfReference(entries)).not.toThrow()
  })
})

describe('buildPayloadInventory', () => {
  test('hashes real files on disk and excludes nothing but throws if a self-referential name is requested', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'cdp-ledger.json'), '{"events":[]}')
    const entries = buildPayloadInventory(dir, ['cdp-ledger.json'])
    expect(entries).toEqual([{ path: 'cdp-ledger.json', bytes: 13, sha256: sha256Hex(readFileSync(join(dir, 'cdp-ledger.json'))) }])
  })

  test('throws if a caller tries to fold the manifest filename into its own inventory', () => {
    const dir = scratch()
    writeFileSync(join(dir, MANIFEST_FILENAME), '{}')
    expect(() => buildPayloadInventory(dir, [MANIFEST_FILENAME])).toThrow(/self-reference/)
  })
})

describe('buildManifest / canonical digest', () => {
  test('the finalized manifest never lists itself or its digest sidecar', () => {
    const manifest = buildManifest(sixTools(), [{ path: 'cdp-ledger.json', bytes: 2, sha256: 'a'.repeat(64) }])
    const paths = manifest.payload.map((p) => p.path)
    expect(paths).not.toContain(MANIFEST_FILENAME)
    expect(paths).not.toContain(DIGEST_FILENAME)
  })

  test('rejects a manifest built with a non-six-tool preflight list', () => {
    expect(() => buildManifest(sixTools().slice(0, 3), [])).toThrow(/expected exactly 6/)
  })

  test('computeManifestDigest changes when payload content changes', () => {
    const base = buildManifest(sixTools(), [{ path: 'a.json', bytes: 1, sha256: 'a'.repeat(64) }])
    const changed = buildManifest(sixTools(), [{ path: 'a.json', bytes: 1, sha256: 'b'.repeat(64) }])
    expect(computeManifestDigest(base)).not.toBe(computeManifestDigest(changed))
  })
})

describe('writeManifest / verifyManifestDigest round trip', () => {
  test('the digest sidecar is an independent file, not embedded in the manifest, and verifies against the manifest on disk', () => {
    const dir = scratch()
    const manifest = buildManifest(sixTools(), [{ path: 'cdp-ledger.json', bytes: 2, sha256: 'c'.repeat(64) }])
    const { manifestPath, digestPath } = writeManifest(dir, manifest)

    const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifestJson.digest).toBeUndefined()
    expect(manifestJson.sha256).toBeUndefined()

    const digestOnDisk = readFileSync(digestPath, 'utf8').trim()
    expect(digestOnDisk).toBe(computeManifestDigest(manifest))
    expect(verifyManifestDigest(manifestPath, digestPath)).toBe(true)
  })

  test('detects a manifest tampered after finalization', () => {
    const dir = scratch()
    const manifest = buildManifest(sixTools(), [])
    const { manifestPath, digestPath } = writeManifest(dir, manifest)
    writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')} `)
    expect(verifyManifestDigest(manifestPath, digestPath)).toBe(false)
  })
})
