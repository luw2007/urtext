/**
 * Deterministic local tarball consumer fixture for I2.
 *
 * Builds the package, `npm pack`s it, and installs the tarball into a fresh
 * consumer project with `npm ci --ignore-scripts --offline`. The fixture
 * packs each installed production dependency path into a local tarball and
 * rewrites the workspace lockfile, avoiding registry metadata. `--ignore-scripts`
 * also skips `better-sqlite3`'s own prebuild-install script (which would otherwise reach the network), so the fixture
 * copies the *already-built* native addon out of this workspace's own
 * `node_modules/better-sqlite3` — the exact artifact this repo's own tests
 * already run against — and proves the copy is byte-identical (hash-bound)
 * before any consumer code touches it. ABI/platform/version compatibility is
 * then proven for real by requiring `better-sqlite3` and opening a database
 * in the consumer process; a mismatch throws immediately at require time.
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..')
})()

const run = (command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const localBin = (name: string): string => {
  const bin = join(REPO_ROOT, 'node_modules', '.bin', name)
  if (!existsSync(bin)) throw new Error(`local ${name} binary not found at ${bin} — no dynamic install fallback`)
  return bin
}

/** `tsc -p tsconfig.json` via the repo-local binary — no `npx`/`tsx`. */
export const buildDist = (): void => {
  const result = run(localBin('tsc'), ['-p', 'tsconfig.json'], REPO_ROOT)
  if (result.status !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`)
}

/** `npm pack` the workspace into `destDir`, returns the absolute tarball path. */
export const packTarball = (destDir: string): string => {
  const result = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', destDir], REPO_ROOT)
  if (result.status !== 0) throw new Error(`npm pack failed:\n${result.stdout}\n${result.stderr}`)
  const name = result.stdout.trim().split('\n').pop()
  if (!name) throw new Error('npm pack produced no output filename')
  return join(destDir, name)
}

/**
 * Installs `tarballPath` with local tarballs for every installed production
 * dependency path — no registry resolution, network, or install scripts.
 */
export const installOffline = (consumerDir: string, tarballPath: string): void => {
  mkdirSync(consumerDir, { recursive: true })
  const dependencyDir = join(consumerDir, '.dependency-tarballs')
  mkdirSync(dependencyDir)

  const pathsResult = run('npm', ['ls', '--omit=dev', '--parseable', '--all'], REPO_ROOT)
  if (pathsResult.status !== 0) throw new Error(`production dependency listing failed:\n${pathsResult.stderr}`)
  const dependencyPaths = pathsResult.stdout.trim().split('\n').filter((path) => path && path !== REPO_ROOT)
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'))
  for (const dependencyPath of dependencyPaths) {
    const lockPath = dependencyPath.slice(REPO_ROOT.length + 1)
    const entry = lock.packages[lockPath]
    if (!entry) throw new Error(`package-lock entry missing for installed dependency ${lockPath}`)
    const result = run(
      'npm',
      ['pack', dependencyPath, '--ignore-scripts', '--silent', '--pack-destination', dependencyDir],
      REPO_ROOT
    )
    if (result.status !== 0) throw new Error(`packing ${lockPath} failed:\n${result.stdout}\n${result.stderr}`)
    const filename = result.stdout.trim().split('\n').pop()
    if (!filename) throw new Error(`packing ${lockPath} produced no output filename`)
    entry.resolved = `file:${join(dependencyDir, filename)}`
    delete entry.integrity
  }

  const packageJson = {
    name: 'urtext-consumer-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: { urtext: `file:${tarballPath}` },
  }
  writeFileSync(join(consumerDir, 'package.json'), JSON.stringify(packageJson, null, 2))
  const workspacePackage = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  lock.name = packageJson.name
  lock.version = packageJson.version
  lock.packages[''] = { name: packageJson.name, version: packageJson.version, dependencies: packageJson.dependencies }
  lock.packages['node_modules/urtext'] = {
    version: workspacePackage.version,
    resolved: `file:${tarballPath}`,
    license: workspacePackage.license,
    dependencies: workspacePackage.dependencies,
    bin: workspacePackage.bin,
    engines: workspacePackage.engines,
  }
  writeFileSync(join(consumerDir, 'package-lock.json'), JSON.stringify(lock, null, 2))

  const result = run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], consumerDir)
  if (result.status !== 0) throw new Error(`offline npm ci failed:\n${result.stdout}\n${result.stderr}`)
  rmSync(dependencyDir, { recursive: true, force: true })
}

export interface NativeClosureProof {
  versionMatches: boolean
  hashMatches: boolean
  sourceHash: string
  installedHash: string
}

/**
 * Copies the workspace's already-built `better-sqlite3` native addon into
 * the offline-installed consumer (whose own copy has no addon, because
 * `--ignore-scripts` skipped its prebuild-install step), then proves the
 * closure: same platform/ABI/version, and a byte-identical (hashed) binary —
 * i.e. reuse of a deterministic local artifact, never a fresh network build.
 */
export const bindNativeClosure = (consumerDir: string): NativeClosureProof => {
  const sourceModuleDir = join(REPO_ROOT, 'node_modules', 'better-sqlite3')
  const installedModuleDir = join(consumerDir, 'node_modules', 'better-sqlite3')
  if (!existsSync(installedModuleDir)) {
    throw new Error(`better-sqlite3 was not installed into the consumer at ${installedModuleDir}`)
  }

  const sourceBinary = join(sourceModuleDir, 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(sourceBinary)) {
    throw new Error(`workspace native addon missing at ${sourceBinary} — build better-sqlite3 first`)
  }
  const sourceHash = createHash('sha256').update(readFileSync(sourceBinary)).digest('hex')

  cpSync(join(sourceModuleDir, 'build'), join(installedModuleDir, 'build'), { recursive: true })

  const installedBinary = join(installedModuleDir, 'build', 'Release', 'better_sqlite3.node')
  const installedHash = createHash('sha256').update(readFileSync(installedBinary)).digest('hex')

  const sourceVersion = JSON.parse(readFileSync(join(sourceModuleDir, 'package.json'), 'utf8')).version as string
  const installedVersion = JSON.parse(readFileSync(join(installedModuleDir, 'package.json'), 'utf8')).version as string

  return {
    versionMatches: sourceVersion === installedVersion,
    hashMatches: sourceHash === installedHash,
    sourceHash,
    installedHash,
  }
}

export const makeScratchDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

export const cleanup = (dirs: string[]): void => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

/** Every top-level entry the tarball ships, relative to the package root. */
export const listTarballEntries = (tarballPath: string): string[] => {
  const result = run('tar', ['-tzf', tarballPath], dirname(tarballPath))
  if (result.status !== 0) throw new Error(`tar listing failed:\n${result.stderr}`)
  return result.stdout.trim().split('\n').filter(Boolean)
}
