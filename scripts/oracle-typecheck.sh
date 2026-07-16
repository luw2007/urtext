#!/bin/sh
# Oracle for C005: the whole repo typechecks under strict settings.
exec npx tsc --noEmit -p tsconfig.json
