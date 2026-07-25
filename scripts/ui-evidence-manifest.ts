#!/usr/bin/env node
/**
 * I3 browser/AX evidence manifest (urtext-20260724-ui-redesign §7.2 I3, §9).
 *
 * A manifest describing the exact-SHA payload of I3's browser/CDP evidence
 * run: six-tool preflight (Node/Git/npm/Bun/cmux/Chrome absolute realpath +
 * version) and a content-addressed inventory of the run's artifact files.
 *
 * Non-self-reference (plan §5.2/P2 pattern applied to I3 evidence): the
 * manifest JSON never lists itself or its digest sidecar in its own payload
 * inventory, and the digest sidecar is computed over the *finalized* manifest
 * bytes as an independent file — never embedded inside the manifest it
 * digests. `buildPayloadInventory`/`assertNoSelfReference` enforce this at
 * build time so a caller cannot accidentally fold the manifest into its own
 * inventory.
 *
 * This module only provides the building blocks; it intentionally does not
 * ship a "produce final receipt" CLI invocation as part of I3 — the trusted
 * final gate (MEC/orchestrator) owns writing the real, immutable BF evidence
 * manifest. `main()` here is for local/manual dry runs only (writes to a
 * caller-supplied `--out`, never a fixed final-evidence path).
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANIFEST_FILENAME = 'ui-browser-evidence-manifest.json'
export const DIGEST_FILENAME = 'manifest.sha256'

export const SIX_TOOL_NAMES = ['node', 'git', 'npm', 'bun', 'cmux', 'chrome'] as const
export type ToolName = (typeof SIX_TOOL_NAMES)[number]

export interface ToolPreflightEntry {
  name: ToolName
  realpath: string
  version: string
}

export interface PayloadEntry {
  path: string
  bytes: number
  sha256: string
}

export interface EvidenceManifest {
  schema: 'urtext.ui-browser-evidence-manifest/1'
  tools: ToolPreflightEntry[]
  payload: PayloadEntry[]
}

/** sha256 hex of an arbitrary byte buffer. */
export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Validates the tool preflight list is exactly the six approved platform
 * tools (§7.2/§8.3.1), each with a non-empty absolute realpath and version,
 * no duplicates, no extras. Throws on any violation — fail-closed.
 */
export const assertSixTools = (tools: ToolPreflightEntry[]): void => {
  if (tools.length !== SIX_TOOL_NAMES.length) {
    throw new Error(`expected exactly ${SIX_TOOL_NAMES.length} preflight tools, got ${tools.length}`)
  }
  const seen = new Set<string>()
  for (const tool of tools) {
    if (!(SIX_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new Error(`unknown preflight tool ${JSON.stringify(tool.name)}`)
    }
    if (seen.has(tool.name)) throw new Error(`duplicate preflight tool ${tool.name}`)
    seen.add(tool.name)
    if (!tool.realpath.startsWith('/')) throw new Error(`${tool.name} realpath must be absolute, got ${JSON.stringify(tool.realpath)}`)
    if (tool.version.trim().length === 0) throw new Error(`${tool.name} version must be non-empty`)
  }
  for (const name of SIX_TOOL_NAMES) {
    if (!seen.has(name)) throw new Error(`missing preflight tool ${name}`)
  }
}

/**
 * Rejects any payload entry whose relative path is the manifest file itself
 * or its digest sidecar — the non-self-reference guard. Also rejects
 * duplicate paths.
 */
export const assertNoSelfReference = (entries: PayloadEntry[]): void => {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.path === MANIFEST_FILENAME || entry.path === DIGEST_FILENAME) {
      throw new Error(`payload inventory must not include ${entry.path} (self-reference)`)
    }
    if (seen.has(entry.path)) throw new Error(`duplicate payload path ${entry.path}`)
    seen.add(entry.path)
  }
}

/** Reads `root/relativePath`, hashes its bytes, and returns a PayloadEntry. */
const hashFile = (root: string, relativePath: string): PayloadEntry => {
  const bytes = readFileSync(join(root, relativePath))
  const { size } = statSync(join(root, relativePath))
  return { path: relativePath, bytes: size, sha256: sha256Hex(bytes) }
}

/**
 * Builds the payload inventory for a set of run-artifact relative paths
 * under `root`. Enforces non-self-reference before returning.
 */
export const buildPayloadInventory = (root: string, relativePaths: string[]): PayloadEntry[] => {
  const entries = relativePaths.map((p) => hashFile(root, p))
  assertNoSelfReference(entries)
  return entries
}

/** Assembles the manifest object. Validates tools and payload before returning. */
export const buildManifest = (tools: ToolPreflightEntry[], payload: PayloadEntry[]): EvidenceManifest => {
  assertSixTools(tools)
  assertNoSelfReference(payload)
  return {
    schema: 'urtext.ui-browser-evidence-manifest/1',
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    payload: [...payload].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/** Canonical (fixed key order, no insignificant whitespace) manifest bytes. */
export const canonicalManifestBytes = (manifest: EvidenceManifest): Buffer =>
  Buffer.from(
    JSON.stringify({
      schema: manifest.schema,
      tools: manifest.tools.map((t) => ({ name: t.name, realpath: t.realpath, version: t.version })),
      payload: manifest.payload.map((p) => ({ path: p.path, bytes: p.bytes, sha256: p.sha256 })),
    }),
    'utf8',
  )

/** Digest sidecar content: sha256 hex of the finalized manifest bytes, computed independently of the manifest's own contents. */
export const computeManifestDigest = (manifest: EvidenceManifest): string => sha256Hex(canonicalManifestBytes(manifest))

/**
 * Writes `<dir>/ui-browser-evidence-manifest.json` and the independent
 * `<dir>/manifest.sha256` digest sidecar. Neither file lists or embeds the
 * other. Returns the paths written.
 */
export const writeManifest = (dir: string, manifest: EvidenceManifest): { manifestPath: string; digestPath: string } => {
  const manifestBytes = canonicalManifestBytes(manifest)
  const manifestPath = join(dir, MANIFEST_FILENAME)
  const digestPath = join(dir, DIGEST_FILENAME)
  writeFileSync(manifestPath, manifestBytes)
  writeFileSync(digestPath, `${sha256Hex(manifestBytes)}\n`)
  return { manifestPath, digestPath }
}

/** Recomputes the digest from manifest bytes on disk and compares to the sidecar — the full recompute/verify flow. */
export const verifyManifestDigest = (manifestPath: string, digestPath: string): boolean => {
  const manifestBytes = readFileSync(manifestPath)
  const recorded = readFileSync(digestPath, 'utf8').trim()
  return sha256Hex(manifestBytes) === recorded
}

const isMain = (): boolean =>
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (isMain()) {
  process.stderr.write(
    'ui-evidence-manifest: library-only in I3; the trusted final gate owns writing the immutable BF evidence manifest.\n',
  )
  process.exit(1)
}
