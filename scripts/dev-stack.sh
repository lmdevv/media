#!/usr/bin/env bash
# Runs an isolated [media] development stack for the current worktree: two self-hosted Convex
# backends in Docker, each with its own volume and ports, plus the media service's credentials and
# a temporary output directory. The core (packages/platform) holds movies, and the media service and
# both web clients use it. Old movies' backend (packages/backend) stays only for its own stack tests
# until its package is deleted. The media service's sign-in boundary also runs alone in a container,
# so the stack suites and the web clients' development servers sign in through it (ADR 0007).
#
#   scripts/dev-stack.sh up        # start (or reuse) both backends, deploy, configure both, write .env.local
#   scripts/dev-stack.sh env       # print this worktree's name, ports, and directories
#   scripts/dev-stack.sh down      # stop and remove the containers (the data volumes stay)
#   scripts/dev-stack.sh destroy   # remove the containers and their data volumes
#
# `up` creates the media service's service principal on the core and issues its key once, keeping
# it in the state directory while the core's volume lives.
#
# The stack name defaults to the worktree directory name; override with MEDIA_STACK. Ports derive
# from the name so worktrees do not collide; override the base with MEDIA_PORT_BASE.
#   base      old movies' Convex API (packages/backend tests only)
#   base + 1  old movies' Convex HTTP actions (auth)
#   base + 2  media service
#   base + 3  movies web dev server (apps/web-movies at /movies/; every other path goes to base + 6)
#   base + 4  core Convex API
#   base + 5  core Convex HTTP actions
#   base + 6  account client dev server (apps/web-account)
#   base + 7  sign-in boundary (the media service's /api/auth/sign-in route alone)
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
boundary_port=$((base + 7))
container="movies-convex-${name}"
core_container="media-platform-convex-${name}"
boundary_container="media-boundary-${name}"
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
web_url=http://localhost:${web_port}/movies/
core_container=${core_container}
core_convex_url=http://127.0.0.1:${core_port}
core_convex_site_url=http://127.0.0.1:${core_site_port}
account_url=http://localhost:${account_port}
boundary_container=${boundary_container}
sign_in_url=http://127.0.0.1:${boundary_port}/api/auth/sign-in
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
    docker rm -f "$container" "$core_container" "$boundary_container" >/dev/null 2>&1 || true
    echo "stopped ${container}, ${core_container}, and ${boundary_container}"
    exit 0
    ;;
  destroy)
    docker rm -f "$container" "$core_container" "$boundary_container" >/dev/null 2>&1 || true
    docker volume rm "${container}-data" "${core_container}-data" >/dev/null 2>&1 || true
    rm -rf "$state_dir" "$(dirname "$transcode_dir")"
    echo "destroyed ${container}, ${core_container}, and ${boundary_container}"
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 [up|env|down|destroy]" >&2
    exit 2
    ;;
esac

mkdir -p "$data_dir" "$transcode_dir" "$backup_dir" "${state_dir}/library"

# The self-hosted backend refuses a mutation once the deployment wrote more than this many bytes in
# the last second (Convex's MAX_BYTES_WRITTEN_PER_SECOND knob, 4 MiB by default; see
# self-hosted/advanced/knobs.md in get-convex/convex-backend). Stack suites seed tens of megabytes
# back to back, so a development stack lifts it; the image and the NixOS module keep the default.
write_limit=$((256 * 1024 * 1024))

start_backend() {
  local box="$1" api_port="$2" http_port="$3"
  # A backend started before the stack set the write limit is recreated; its data volume stays.
  if docker inspect "$box" >/dev/null 2>&1 &&
    ! docker inspect -f '{{join .Config.Env "\n"}}' "$box" | grep -qx "MAX_BYTES_WRITTEN_PER_SECOND=${write_limit}"; then
    docker rm -f "$box" >/dev/null
  fi
  if ! docker inspect "$box" >/dev/null 2>&1; then
    # The backend fetches its own OIDC discovery document from CONVEX_SITE_ORIGIN to verify auth
    # tokens, so it listens inside the container on the same ports the host uses.
    docker run -d --name "$box" \
      -p "127.0.0.1:${api_port}:${api_port}" -p "127.0.0.1:${http_port}:${http_port}" \
      -v "${box}-data:/convex/data" \
      -e CONVEX_CLOUD_ORIGIN="http://127.0.0.1:${api_port}" \
      -e CONVEX_SITE_ORIGIN="http://127.0.0.1:${http_port}" \
      -e DISABLE_BEACON=1 \
      -e MAX_BYTES_WRITTEN_PER_SECOND="${write_limit}" \
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

cd "${root}/packages/backend"
pnpm exec convex deploy --yes >/dev/null
# Configures old movies' own deployment for its stack tests, which read the media service
# credentials it prints from packages/backend/.env.local; the media service itself uses the core.
if [[ -f scripts/configure.ts ]]; then
  backend_media_env="$(node scripts/configure.ts --site-url "http://localhost:${web_port}" \
    --media-url "http://127.0.0.1:${media_port}")"
  printf '%s\n' "$backend_media_env" >>"${root}/packages/backend/.env.local"
  unset backend_media_env
fi

core_admin_key="$(docker exec "$core_container" ./generate_admin_key.sh | tail -n 1)"

sign_in_url="http://127.0.0.1:${boundary_port}/api/auth/sign-in"

cat >"${root}/packages/platform/.env.local" <<ENV
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${core_port}
CONVEX_SELF_HOSTED_ADMIN_KEY=${core_admin_key}
MEDIA_SIGN_IN_URL=${sign_in_url}
ENV

cat >"${root}/apps/web-account/.env.local" <<ENV
VITE_PLATFORM_URL=http://127.0.0.1:${core_port}
VITE_MEDIA_BASE_URL=http://127.0.0.1:${media_port}
VITE_SIGN_IN_URL=${sign_in_url}
ACCOUNT_PORT=${account_port}
ENV

cat >"${root}/apps/web-movies/.env.local" <<ENV
VITE_PLATFORM_URL=http://127.0.0.1:${core_port}
VITE_MEDIA_BASE_URL=http://127.0.0.1:${media_port}
VITE_SIGN_IN_URL=${sign_in_url}
WEB_PORT=${web_port}
ACCOUNT_DEV_URL=http://localhost:${account_port}
ENV

cd "${root}/packages/platform"
pnpm exec convex deploy --yes >/dev/null
node scripts/configure.ts
pnpm exec convex run core/schemaMigrations:run >/dev/null

# The media service's service principal and key on the core. The key is shown once, so it is kept
# in the state directory, beside the creation time of the core's volume it belongs to; a new volume
# gets a new principal, and a lost key a new key, whose first use retires the old ones. The key
# goes from the CLI's output to the file, never to a command line.
service_id_file="${state_dir}/core-service-id"
service_key_file="${state_dir}/core-service-key"
service_volume_file="${state_dir}/core-service-volume"
core_volume="$(docker volume inspect -f '{{.CreatedAt}}' "${core_container}-data")"
if [[ "$(cat "$service_volume_file" 2>/dev/null)" != "$core_volume" ]]; then
  rm -f "$service_id_file" "$service_key_file"
fi
json_value() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const v = JSON.parse(s); process.stdout.write(process.argv[1] ? v[process.argv[1]] : v); })' "${1:-}"
}
create_service() {
  pnpm exec convex run core/accounts/host:createService '{"name":"media server"}' | json_value \
    >"${service_id_file}.partial"
  mv "${service_id_file}.partial" "$service_id_file"
  printf '%s\n' "$core_volume" >"$service_volume_file"
}
issue_service_key() {
  pnpm exec convex run core/auth/apiKeys:issueServiceKey "{\"serviceId\":\"$(<"$service_id_file")\"}" |
    json_value key >"${service_key_file}.partial"
}
if [[ ! -s "$service_key_file" ]]; then
  [[ -s "$service_id_file" ]] || create_service
  (
    umask 077
    if ! issue_service_key; then
      create_service
      issue_service_key
    fi
  )
  mv "${service_key_file}.partial" "$service_key_file"
fi
media_ticket_keys="$(pnpm exec convex env get MEDIA_TICKET_KEYS)"

# The sign-in boundary, built from this checkout and run alone on the host's network, so it reaches
# the core on loopback. Its settings, the ticket keys among them, go through a file, never argv.
node "${root}/apps/media/scripts/build.ts" --boundary >/dev/null
boundary_env="${state_dir}/boundary.env"
(
  umask 077
  cat >"$boundary_env" <<ENV
CONVEX_URL=http://127.0.0.1:${core_port}
MEDIA_TICKET_KEYS=${media_ticket_keys}
HOST=127.0.0.1
PORT=${boundary_port}
ENV
)
node_image="$(sed -n 's/^ARG NODE_IMAGE=//p' "${root}/deploy/image/Dockerfile")"
docker rm -f "$boundary_container" >/dev/null 2>&1 || true
docker run -d --name "$boundary_container" --network host \
  --user "$(id -u):$(id -g)" --env-file "$boundary_env" \
  -v "${root}/apps/media/dist:/app:ro" "$node_image" node /app/sign-in-boundary.js >/dev/null
# A CORS preflight answers 204 once the route is up, and spends no sign-in try, as a POST would.
boundary_ready() {
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://localhost' \
    -H 'Access-Control-Request-Method: POST' "$sign_in_url")" == 204 ]]
}
for _ in $(seq 1 60); do
  boundary_ready && break
  sleep 0.5
done
if ! boundary_ready; then
  echo "The sign-in boundary did not answer at ${sign_in_url} within 30 s" >&2
  docker logs --tail 40 "$boundary_container" >&2 || true
  exit 1
fi

(
  umask 077
  cat >"${root}/apps/media/.env.local" <<ENV
CONVEX_URL=http://127.0.0.1:${core_port}
CONVEX_PUBLIC_URL=http://127.0.0.1:${core_port}
MEDIA_SERVICE_API_KEY=$(<"$service_key_file")
MEDIA_TICKET_KEYS=${media_ticket_keys}
CONVEX_SELF_HOSTED_ADMIN_KEY=${core_admin_key}
CONVEX_BACKEND_DIR=${root}/packages/platform
MEDIA_BASE_URL=http://127.0.0.1:${media_port}
PORT=${media_port}
DATA_DIR=${data_dir}
TRANSCODE_DIR=${transcode_dir}
BACKUP_DIR=${backup_dir}
LIBRARY_ROOTS=${library_roots}
ENV
)

print_env
