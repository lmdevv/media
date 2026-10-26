#!/usr/bin/env bash
# How many of a library's songs LRCLIB has lyrics for (see apps/media/scripts/lrclib-coverage.ts).
# Bundles the script with the media service's own LRCLIB client, as `apps/media/scripts/build.ts`
# bundles the service (CommonJS dependencies need `require`), and runs it; arguments pass through,
# such as `--sample 200 --seed 7`.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

pnpm --dir "$root/apps/media" exec esbuild scripts/lrclib-coverage.ts \
  --bundle --platform=node --target=node24 --format=esm --log-level=warning \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile="$out/lrclib-coverage.mjs"

node "$out/lrclib-coverage.mjs" "$@"
