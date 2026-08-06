# Urtext interface-surface contracts

## I001 CLI command surface <!-- surface:src/cli.ts -->

The command-line boundary keeps command parsing, exit status, and reported facts coherent for operators.

## I002 Registry schema <!-- surface:src/registry.ts,src/dwarf.ts -->

The persistent registry and clause-to-code mapping schemas preserve durable evidence and attribution boundaries.

## I003 Public package exports <!-- surface:src/index.ts -->

The package export list remains the consumer-facing TypeScript API.

## I004 Evidence and verifier wire <!-- surface:src/verifier.ts -->

The verifier executes ready clauses and appends their objective evidence without replacing it.
