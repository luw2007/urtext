#!/usr/bin/env sh
set -eu

case "${1:?usage: oracle-skill.sh <skill-name>}" in
  codebase-to-spec)
    skill=.claude/skills/codebase-to-spec/SKILL.md
    template=.claude/skills/codebase-to-spec/references/draft-template.md
    test -f "$skill"
    test -f "$template"
    grep -q '\.urtext/distill/facts\.json' "$skill"
    grep -q 'Never create or edit `specs/` during synthesis' "$skill"
    grep -q 'Mark every candidate `observed` or `inferred`' "$skill"
    grep -q 'evidence gap' "$skill"
    grep -q 'Status\*\*: Candidate — not canonical' "$template"
    grep -q 'req:FR' "$template"
    ;;
  *)
    echo "unknown skill: $1" >&2
    exit 1
    ;;
esac
