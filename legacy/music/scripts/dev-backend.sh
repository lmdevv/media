#!/usr/bin/env bash
# Starts a self-hosted Convex backend in Docker for local development, deploys the functions,
# sets the deployment environment, and writes the .env.local files the apps read.
#
#   scripts/dev-backend.sh [name] [port]     # defaults: main 3210
#   scripts/dev-backend.sh stop [name]
#
# Each worktree can run its own backend by picking a different name and port. The backend uses
# `port` for the API and `port + 1` for HTTP actions. The media service port is `port + 890`
# (4100 for the default 3210) and the web dev server stays on 3001 unless WEB_PORT is set.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="ghcr.io/get-convex/convex-backend:latest"

if [[ "${1:-}" == "stop" ]]; then
  docker rm -f "music-convex-${2:-main}" >/dev/null
  echo "stopped music-convex-${2:-main}"
  exit 0
fi

name="${1:-main}"
port="${2:-3210}"
site_port=$((port + 1))
media_port="${MEDIA_PORT:-$((port + 890))}"
web_port="${WEB_PORT:-3001}"
container="music-convex-${name}"

if ! docker inspect "$container" >/dev/null 2>&1; then
  # The backend fetches its own OIDC discovery document from CONVEX_SITE_ORIGIN to verify auth
  # tokens, so it must listen inside the container on the same ports the host uses.
  docker run -d --name "$container" \
    -p "127.0.0.1:${port}:${port}" -p "127.0.0.1:${site_port}:${site_port}" \
    -v "${container}-data:/convex/data" \
    -e CONVEX_CLOUD_ORIGIN="http://127.0.0.1:${port}" \
    -e CONVEX_SITE_ORIGIN="http://127.0.0.1:${site_port}" \
    -e DISABLE_BEACON=1 \
    --entrypoint bash "$image" -c \
    "sed -e 's/--port 3210/--port ${port}/' -e 's/--site-proxy-port 3211/--site-proxy-port ${site_port}/' run_backend.sh >/tmp/run_backend.sh && exec bash /tmp/run_backend.sh" \
    >/dev/null
elif [[ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]]; then
  docker start "$container" >/dev/null
fi

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/version" >/dev/null 2>&1 && break
  sleep 1
done

admin_key="$(docker exec "$container" ./generate_admin_key.sh | tail -n 1)"

cat >"${root}/packages/backend/.env.local" <<ENV
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${port}
CONVEX_SELF_HOSTED_ADMIN_KEY=${admin_key}
ENV

cd "${root}/packages/backend"
pnpm exec convex deploy --yes >/dev/null
node scripts/configure.ts --site-url "http://localhost:${web_port}" \
  --media-url "http://127.0.0.1:${media_port}/media" >/dev/null

secret="$(pnpm exec convex env get MEDIA_SERVICE_SECRET)"
signing="$(pnpm exec convex env get STREAM_SIGNING_KEY)"

cat >"${root}/apps/web/.env.local" <<ENV
VITE_CONVEX_URL=http://127.0.0.1:${port}
ENV

cat >"${root}/apps/media/.env.local" <<ENV
CONVEX_URL=http://127.0.0.1:${port}
MEDIA_SERVICE_SECRET=${secret}
STREAM_SIGNING_KEY=${signing}
MEDIA_DATA_DIR=${HOME}/.local/share/music-dev/${name}
PORT=${media_port}
ENV

echo "Convex ${name}: http://127.0.0.1:${port} (HTTP actions ${site_port}), media port ${media_port}"
echo "Dashboard: docker run --rm -p 6791:6791 -e NEXT_PUBLIC_DEPLOYMENT_URL=http://127.0.0.1:${port} ghcr.io/get-convex/convex-dashboard"
echo "Admin key is in packages/backend/.env.local"
