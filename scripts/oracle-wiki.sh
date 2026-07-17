#!/usr/bin/env sh
# oracle-wiki.sh — cmd oracles for the documentation wiki (docs/wiki/).
# The wiki promotes Urtext's mechanism; a wiki that drifts from the real command
# set is a silent lie — exactly what the whole system exists to prevent. So the
# consistency check is enforced, not left to discipline (VISION P3).
# Usage: scripts/oracle-wiki.sh <check-name>. Exit 0 = green.
set -eu
REF=docs/wiki/guides/03-command-reference.md
INDEX=docs/wiki/index.md

case "${1:?usage: oracle-wiki.sh <check-name>}" in
  # Every command in cli.ts COMMANDS must be documented in the command reference.
  command-coverage)
    for cmd in index check verify impact map ack blame audit gate review decide decisions; do
      grep -q "urtext $cmd" "$REF" || { echo "command-reference.md missing: urtext $cmd" >&2; exit 1; }
    done ;;
  # The three-layer structure must stay wired: index links concepts/mechanisms/guides.
  three-layers)
    grep -q 'concepts/' "$INDEX" && grep -q 'mechanisms/' "$INDEX" && grep -q 'guides/' "$INDEX" ;;
  *)
    echo "unknown check: $1" >&2; exit 1 ;;
esac
