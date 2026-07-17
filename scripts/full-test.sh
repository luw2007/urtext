#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

run_negcheck() {
  oracle=scripts/oracle-loops.sh
  oracle_var=$(
    sed -n '/^[[:space:]]*reproduce-first)/,/^[[:space:]]*[[:alnum:]-][[:alnum:]-]*)/p' "$oracle" \
      | sed -n 's/.*"\(\$[A-Z][A-Z0-9_]*\)".*/\1/p' \
      | sed -n '1p'
  )
  test -n "$oracle_var" || {
    echo "negcheck: could not resolve reproduce-first target variable" >&2
    exit 1
  }

  var_name=${oracle_var#\$}
  target=$(sed -n "s/^${var_name}=//p" "$oracle" | sed -n '1p')
  test -n "$target" && test -f "$target" || {
    echo "negcheck: resolved target is missing: $target" >&2
    exit 1
  }

  tmp=/tmp/urtext-negcheck-$$
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  rm -rf "$tmp"
  mkdir "$tmp"
  cp -R "$ROOT/." "$tmp"

  sed '/REPRODUCE FIRST/d' "$tmp/$target" > "$tmp/$target.tmp"
  mv "$tmp/$target.tmp" "$tmp/$target"

  verify_output="$tmp/verify.out"
  verify_rc=0
  (cd "$tmp" && npx --prefix "$ROOT" --no-install tsx src/cli.ts verify) > "$verify_output" || verify_rc=$?

  if [ "$verify_rc" -ne 1 ]; then
    cat "$verify_output"
    echo "negcheck: expected verify exit 1, got $verify_rc" >&2
    exit 1
  fi
  if ! grep -q 'C301' "$verify_output"; then
    cat "$verify_output"
    echo "negcheck: verify output did not contain C301" >&2
    exit 1
  fi

  grep 'C301' "$verify_output"
  echo "NEGATIVE CHECK PASS: removing REPRODUCE FIRST made C301 red (verify exit 1)"
}

case "${1-}" in
  '')
    npx tsc --noEmit -p tsconfig.json
    npx vitest run
    npx tsx src/cli.ts verify
    bun build .claude/workflows/urtext-overnight-hunt.js --no-bundle
    bun build .claude/workflows/urtext-fix-cycle.js --no-bundle
    bun build .claude/workflows/urtext-spec-audit.js --no-bundle
    echo "FULL TEST PASS"
    ;;
  --negcheck)
    run_negcheck
    ;;
  *)
    echo "usage: $0 [--negcheck]" >&2
    exit 2
    ;;
esac
