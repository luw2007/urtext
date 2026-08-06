import type { FeatureContract } from './contract-parser.js'

const segmentMatches = (pattern: string, segment: string): boolean => {
  let expression = '^'
  for (const character of pattern) {
    expression += character === '*' ? '[^/]*' : character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`).test(segment)
}

export const matchSurface = (pattern: string, filePath: string): boolean => {
  if (!pattern.includes('*')) return pattern === filePath

  const patternSegments = pattern.split('/')
  const pathSegments = filePath.split('/')
  const matches = (patternIndex: number, pathIndex: number): boolean => {
    const segment = patternSegments[patternIndex]
    if (segment === undefined) return pathIndex === pathSegments.length
    if (segment === '**') {
      return (
        matches(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && matches(patternIndex, pathIndex + 1))
      )
    }
    const pathSegment = pathSegments[pathIndex]
    return pathSegment !== undefined && segmentMatches(segment, pathSegment) && matches(patternIndex + 1, pathIndex + 1)
  }
  return matches(0, 0)
}

export const classifyUnmapped = <T extends { file: string }>(
  hunks: readonly T[],
  contracts: readonly FeatureContract[],
  opts: { oldPathOf?: (hunk: T) => string | null } = {}
): (T & { matchedInterfaces: string[] })[] =>
  hunks.map((hunk) => {
    const oldPath = opts.oldPathOf?.(hunk) ?? null
    const matchedInterfaces = new Set<string>()
    for (const contract of contracts) {
      for (const entry of contract.entries) {
        if (entry.surfaces.some((surface) => matchSurface(surface, hunk.file) || (oldPath !== null && matchSurface(surface, oldPath)))) {
          matchedInterfaces.add(entry.interfaceId)
        }
      }
    }
    return { ...hunk, matchedInterfaces: [...matchedInterfaces].sort() }
  })
