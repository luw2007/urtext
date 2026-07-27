#!/bin/sh
# Oracle for C005: the whole repo typechecks under strict settings.
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
TSC="$ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "oracle-typecheck: local tsc binary not found at $TSC — no dynamic install fallback" >&2
  exit 1
fi
echo "verified: source strict + exactOptionalPropertyTypes typecheck (tsconfig.json)"
"$TSC" --noEmit -p "$ROOT/tsconfig.json"
echo "verified: repo-wide strict + exactOptionalPropertyTypes typecheck (src, tests, scripts; tsconfig.repo.json)"
"$TSC" --noEmit -p "$ROOT/tsconfig.repo.json"
