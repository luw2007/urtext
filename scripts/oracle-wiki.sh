#!/usr/bin/env sh
# oracle-wiki.sh — cmd oracles for the documentation wiki (docs/wiki/).
# The wiki promotes Urtext's mechanism; a wiki that drifts from the real command
# set is a silent lie — exactly what the whole system exists to prevent. So the
# consistency check is enforced, not left to discipline (VISION P3).
# Usage: scripts/oracle-wiki.sh <check-name>. Exit 0 = green.
set -eu
REF=docs/wiki/guides/03-command-reference.md
INDEX=docs/wiki/index.md

# Extract command keys from the runtime source, not a duplicated command list.
# `ui` dispatches outside run(), so retain all object keys and the explicit ui branch.
command_names() {
  {
    sed -n '/const COMMANDS: Record<string, true> = {/,/^  }/p' src/cli.ts \
      | sed -n 's/^    \([a-z][a-z-]*\): true,$/\1/p'
    sed -n "s/^  if (process.argv\[2\] === '\([a-z][a-z-]*\)') {$/\1/p" src/cli.ts
  } | sort -u
}

case "${1:?usage: oracle-wiki.sh <check-name>}" in
  # Every runtime CLI command must be documented in the command reference.
  command-coverage)
    commands=$(command_names)
    test -n "$commands" || { echo "cli.ts yielded no runtime commands" >&2; exit 1; }
    printf '%s\n' "$commands" | while IFS= read -r cmd; do
      grep -q "urtext $cmd" "$REF" || { echo "command-reference.md missing: urtext $cmd" >&2; exit 1; }
      echo "verified: runtime command '$cmd' documented in $REF"
    done ;;
  # The three-layer structure must stay wired: index links concepts/mechanisms/guides.
  three-layers)
    grep -q 'concepts/' "$INDEX" && grep -q 'mechanisms/' "$INDEX" && grep -q 'guides/' "$INDEX" ;;
  *)
    echo "unknown check: $1" >&2; exit 1 ;;
esac
