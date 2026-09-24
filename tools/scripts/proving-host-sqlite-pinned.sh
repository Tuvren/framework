#!/usr/bin/env bash
# Live-verification drive for the reference-host SQLite recipe.
# Each run gets a private temp directory, deleted on exit, so cleanup cannot
# remove another run's database. pipefail keeps a failing CLI from being hidden
# by the assert helper. The helper only checks that JSONL is nonempty and has
# no error record, so this script also requires a text.delta from the turn.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
dir=$(mktemp -d "${TMPDIR:-/tmp}/tuvren-live-recipe.XXXXXX")
trap 'rm -rf "$dir"' EXIT

cd "$root/typescript/host/repl"
node dist/cli.js --scenario reload --backend sqlite --provider fixture --sqlite-path "$dir/reload.sqlite"
printf '.status\n.turn start streaming\n.turn await\n.exit\n' \
  | node dist/cli.js --headless --stream-jsonl --backend sqlite --provider fixture --sqlite-path "$dir/headless.sqlite" \
  | tee "$dir/out.jsonl" \
  | bun smoke/assert-headless-jsonl.ts
grep -q '"type":"text.delta"' "$dir/out.jsonl"
