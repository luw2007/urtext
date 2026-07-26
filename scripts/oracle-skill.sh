#!/usr/bin/env sh
set -eu

# Print each verified assertion: evidence must carry what was checked, not a
# silent exit code — meta-audit reads the output, not this script.
check() {
  pattern=$1
  file=$2
  grep -q "$pattern" "$file"
  echo "verified: '$pattern' present in $file"
}

case "${1:?usage: oracle-skill.sh <skill-name>}" in
  codebase-to-spec)
    skill=.claude/skills/codebase-to-spec/SKILL.md
    template=.claude/skills/codebase-to-spec/references/draft-template.md
    test -f "$skill" && echo "verified: $skill exists"
    test -f "$template" && echo "verified: $template exists"
    check '\.urtext/distill/facts\.json' "$skill"
    check 'Never create or edit `specs/` during synthesis' "$skill"
    check 'Mark every candidate `observed` or `inferred`' "$skill"
    check 'evidence gap' "$skill"
    check 'Status\*\*: Candidate — not canonical' "$template"
    check 'req:FR' "$template"
    ;;
  *)
    echo "unknown skill: $1" >&2
    exit 1
    ;;
esac
