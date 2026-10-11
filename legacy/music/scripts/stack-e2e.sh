#!/usr/bin/env bash
# Builds the image, starts a fresh container with a music library, and runs the real-stack
# end-to-end suite (apps/web/e2e-stack) against it.
#
#   scripts/stack-e2e.sh                 # generated fixture library
#   MUSIC_DIR=~/music scripts/stack-e2e.sh
#
# Env: IMAGE (skip the build and use this image), PORT (default 8090), CHROMIUM_PATH, KEEP=1 to
# leave the container running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${PORT:-8090}"
name="music-stack-e2e"
image="${IMAGE:-}"

if [[ -z "$image" ]]; then
  image="music:stack-e2e"
  docker build -f "$root/deploy/docker/Dockerfile" -t "$image" "$root"
fi

library="${MUSIC_DIR:-}"
if [[ -z "$library" ]]; then
  library="$(mktemp -d)"
  node "$root/apps/media/scripts/generate-fixtures.ts" "$library"
fi

pnpm --dir "$root" --filter @music/cli build

docker rm -f "$name" >/dev/null 2>&1 || true
docker volume rm "$name-data" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:${port}:8080" -v "$name-data:/data" \
  -v "$library:/music:ro" -e PUBLIC_URL="http://localhost:${port}" "$image" >/dev/null

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$name-data" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  curl -fsS "http://localhost:${port}/media/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://localhost:${port}/media/health" >/dev/null || {
  docker logs "$name" | tail -50
  exit 1
}

MUSIC_URL="http://localhost:${port}" pnpm --dir "$root" --filter web test:stack
