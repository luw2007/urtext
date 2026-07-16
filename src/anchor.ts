/**
 * Shared HTML-comment anchor tokenizer. Anchors carry machine metadata while
 * the visible markdown stays clean GFM:
 *
 *   <!-- oracle:test:tests/x.test.ts risk:high refs:a.md#C001,b.md#C002 -->
 *
 * Tokens are whitespace-separated `key:value` pairs; values contain no spaces
 * (lists use commas), so both clause files and checklists parse anchors
 * identically.
 */

export interface AnchorParseIssue {
  token: string
  message: string
}

export interface ParsedAnchor {
  fields: Record<string, string>
  issues: AnchorParseIssue[]
}

export const parseAnchorFields = (raw: string): ParsedAnchor => {
  const fields: Record<string, string> = {}
  const issues: AnchorParseIssue[] = []
  for (const token of raw.split(/\s+/)) {
    if (!token) continue
    const colon = token.indexOf(':')
    if (colon <= 0) {
      issues.push({ token, message: `Anchor token "${token}" is not a key:value pair.` })
      continue
    }
    fields[token.slice(0, colon)] = token.slice(colon + 1)
  }
  return { fields, issues }
}
