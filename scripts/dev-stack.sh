#!/usr/bin/env bash
# Runs an isolated [media] development stack for the current worktree: two self-hosted Convex
# backends in Docker, one for old movies (packages/backend) and one for the platform core
# (packages/platform), each with its own volume and ports, plus the movies service credential and
# a temporary output directory. The core has its own backend until the movies port moves movies
# into it (docs/decisions/0023).
#
#   scripts/dev-stack.sh up        # start (or reuse) both backends, deploy, configure both, write .env.local
#   scripts/dev-stack.sh env       # print this worktree's name, ports, and directories
#   scripts/dev-stack.sh down      # stop and remove both containers (the data volumes stay)
#   scripts/dev-stack.sh destroy   # remove both containers and their data volumes
#
# The stack name defaults to the worktree directory name; override with MEDIA_STACK. Ports derive
# from the name so worktrees do not collide; override the base with MEDIA_PORT_BASE.
#   base      Convex API
#   base + 1  Convex HTTP actions (auth)
#   base + 2  media service
#   base + 3  web dev server
#   base + 4  core Convex API
#   base + 5  core Convex HTTP actions
#   base + 6  account client dev server (apps/web-account)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="${CONVEX_BACKEND_IMAGE:-$(<"${root}/deploy/convex-backend.image")}"

raw_name="${MEDIA_STACK:-$(basename "$root")}"
name="$(printf '%s' "$raw_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')"

if [[ -n "${MEDIA_PORT_BASE:-}" ]]; then
  base="$MEDIA_PORT_BASE"
else
  slot=$(($(printf '%s' "$name" | cksum | cut -d' ' -f1) % 40))
  base=$((13200 + slot * 10))
fi

convex_port="$base"
site_port=$((base + 1))
media_port=$((base + 2))
web_port=$((base + 3))
core_port=$((base + 4))
core_site_port=$((base + 5))
account_port=$((base + 6))
container="movies-convex-${name}"
core_container="media-platform-convex-${name}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/movies-dev/${name}"
data_dir="${state_dir}/data"
transcode_dir="${TMPDIR:-/tmp}/movies-dev-${name}/transcode"
backup_dir="${state_dir}/backups"
library_roots="${MEDIA_LIBRARY_ROOTS:-${state_dir}/library}"

print_env() {
  cat <<EOF
name=${name}
container=${container}
convex_url=http://127.0.0.1:${convex_port}
convex_site_url=http://127.0.0.1:${site_port}
media_url=http://127.0.0.1:${media_port}
web_url=http://localhost:${web_port}
core_container=${core_container}
core_convex_url=http://127.0.0.1:${core_port}
core_convex_site_url=http://127.0.0.1:${core_site_port}
account_url=http://localhost:${account_port}
data_dir=${data_dir}
transcode_dir=${transcode_dir}
backup_dir=${backup_dir}
library_roots=${library_roots}
EOF
}

case "${1:-up}" in
  env)
    print_env
    exit 0
    ;;
  down)
    docker rm -f "$container" "$core_container" >/dev/null 2>&1 || true
    echo "stopped ${container} and ${core_container}"
    exit 0
    ;;
  destroy)
    docker rm -f "$container" "$core_container" >/dev/null 2>&1 || true
    docker volume rm "${container}-data" "${core_container}-data" >/dev/null 2>&1 || true
    rm -rf "$state_dir" "$(dirname "$transcode_dir")"
    echo "destroyed ${container} and ${core_container}"
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 [up|env|down|destroy]" >&2
    exit 2
    ;;
esac

mkdir -p "$data_dir" "$transcode_dir" "$backup_dir" "${state_dir}/library"

start_backend() {
  local box="$1" api_port="$2" http_port="$3"
  if ! docker inspect "$box" >/dev/null 2>&1; then
    # The backend fetches its own OIDC discovery document from CONVEX_SITE_ORIGIN to verify auth
    # tokens, so it listens inside the container on the same ports the host uses.
    docker run -d --name "$box" \
      -p "127.0.0.1:${api_port}:${api_port}" -p "127.0.0.1:${http_port}:${http_port}" \
      -v "${box}-data:/convex/data" \
      -e CONVEX_CLOUD_ORIGIN="http://127.0.0.1:${api_port}" \
      -e CONVEX_SITE_ORIGIN="http://127.0.0.1:${http_port}" \
      -e DISABLE_BEACON=1 \
      --entrypoint bash "$image" -c \
      "sed -e 's/--port 3210/--port ${api_port}/' -e 's/--site-proxy-port 3211/--site-proxy-port ${http_port}/' run_backend.sh >/tmp/run_backend.sh && exec bash /tmp/run_backend.sh" \
      >/dev/null
  elif [[ "$(docker inspect -f '{{.State.Running}}' "$box")" != "true" ]]; then
    docker start "$box" >/dev/null
  fi
}

wait_backend() {
  local box="$1" api_port="$2"
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${api_port}/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Convex did not answer at http://127.0.0.1:${api_port} within 60 s" >&2
  docker logs --tail 40 "$box" >&2 || true
  exit 1
}

start_backend "$container" "$convex_port" "$site_port"
start_backend "$core_container" "$core_port" "$core_site_port"
wait_backend "$container" "$convex_port"
wait_backend "$core_container" "$core_port"

admin_key="$(docker exec "$container" ./generate_admin_key.sh | tail -n 1)"

cat >"${root}/packages/backend/.env.local" <<ENV
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${convex_port}
CONVEX_SELF_HOSTED_ADMIN_KEY=${admin_key}
ENV

cat >"${root}/apps/web/.env.local" <<ENV
VITE_CONVEX_URL=http://127.0.0.1:${convex_port}
VITE_MEDIA_BASE_URL=http://127.0.0.1:${media_port}
WEB_PORT=${web_port}
ENV

cd "${root}/packages/backend"
pnpm exec convex deploy --yes >/dev/null

media_env=""
if [[ -f scripts/configure.ts ]]; then
  media_env="$(node scripts/configure.ts --site-url "http://localhost:${web_port}" \
    --media-url "http://127.0.0.1:${media_port}")"
fi

cat >"${root}/apps/media/.env.local" <<ENV
CONVEX_URL=http://127.0.0.1:${convex_port}
CONVEX_PUBLIC_URL=http://127.0.0.1:${convex_port}
MEDIA_BASE_URL=http://127.0.0.1:${media_port}
PORT=${media_port}
DATA_DIR=${data_dir}
TRANSCODE_DIR=${transcode_dir}
BACKUP_DIR=${backup_dir}
LIBRARY_ROOTS=${library_roots}
CONVEX_BACKEND_DIR=${root}/packages/backend
CONVEX_SELF_HOSTED_ADMIN_KEY=${admin_key}
${media_env}
ENV

core_admin_key="$(docker exec "$core_container" ./generate_admin_key.sh | tail -n 1)"

cat >"${root}/packages/platform/.env.local" <<ENV
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${core_port}
CONVEX_SELF_HOSTED_ADMIN_KEY=${core_admin_key}
ENV

cat >"${root}/apps/web-account/.env.local" <<ENV
VITE_PLATFORM_URL=http://127.0.0.1:${core_port}
ACCOUNT_PORT=${account_port}
ENV

cd "${root}/packages/platform"
pnpm exec convex deploy --yes >/dev/null
node scripts/configure.ts
pnpm exec convex run core/schemaMigrations:run >/dev/null

print_env
