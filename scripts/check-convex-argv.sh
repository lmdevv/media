#!/usr/bin/env bash
# Checks that the NixOS module's Convex container keeps its instance secret off every command line
# (docs/security.md). It runs the pinned Convex image the way nix/module.nix does, with
# nix/convex-entry.sh and the argv-secret shim from the Nix package, then:
#
#   - no process on the host shows the secret in /proc/<pid>/cmdline, while the backend's shows
#     the placeholder;
#   - the backend answers, so the shim handed it the real secret;
#   - `generate_key` through the shim, as the module's setup runs it, derives an admin key the
#     backend accepts.
#
# Needs Docker and Nix. Usage: scripts/check-convex-argv.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"${root}/deploy/convex-backend.image")"
name="check-convex-argv-$$"
package="$(nix build --no-link --print-out-paths "${root}#movies")"
shim="${package}/lib/movies/convex/argv-secret.so"
data="$(mktemp -d)"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run --rm --network none -v "${data}:/d" --entrypoint /bin/sh "$image" -c 'rm -rf /d/*' \
    >/dev/null 2>&1 || true
  rmdir "$data" 2>/dev/null || true
}
trap cleanup EXIT

failures=0
check() {
  if eval "$2"; then echo "ok: $1"; else echo "check failed: $1" >&2; failures=$((failures + 1)); fi
}

docker run -d --name "$name" --network none \
  -e INSTANCE_NAME=core \
  -e CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210 \
  -e CONVEX_SITE_ORIGIN=http://127.0.0.1:3211 \
  -v "${data}:/convex/data" \
  -v "${root}/nix/convex-entry.sh:/media-convex-entry.sh:ro" \
  -v "${shim}:/argv-secret.so:ro" \
  --entrypoint /bin/bash "$image" /media-convex-entry.sh >/dev/null

for _ in $(seq 1 60); do
  docker exec "$name" curl -fsS http://127.0.0.1:3210/version >/dev/null 2>&1 && break
  sleep 1
done

check "the backend answers" 'docker exec "$name" curl -fsS http://127.0.0.1:3210/version >/dev/null'

secret="$(docker exec "$name" cat /convex/data/credentials/instance_secret)"
pid="$(docker inspect -f '{{.State.Pid}}' "$name")"

check "the entrypoint made a 32-byte hex secret" '[[ "$secret" =~ ^[0-9a-f]{64}$ ]]'
check "the backend's command line shows the placeholder" \
  'tr "\0" " " <"/proc/${pid}/cmdline" | grep -qF -- "--instance-secret @ARGV_SECRET_FILE"'
check "no command line on the host holds the secret" \
  '! grep -sqaF "$secret" /proc/[0-9]*/cmdline'
check "the backend's environment holds no secret, only its file's path" \
  '! docker exec "$name" sh -c "cat /proc/1/environ" | tr "\0" "\n" | grep -qF "$secret"'

admin_key="$(docker exec -e LD_PRELOAD=/argv-secret.so \
  -e ARGV_SECRET_FILE=/convex/data/credentials/instance_secret "$name" \
  /convex/generate_key core @ARGV_SECRET_FILE | tail -n 1)"

admin_status() {
  docker exec "$name" curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Convex $1" \
    http://127.0.0.1:3210/api/check_admin_key
}

check "generate_key through the shim derives an admin key the backend accepts" \
  '[[ "$(admin_status "$admin_key")" == 200 && "$(admin_status "core|00not-a-key")" == 401 ]]'
check "the shim refuses a placeholder without its file" \
  '! docker exec -e LD_PRELOAD=/argv-secret.so "$name" /convex/generate_key core @ARGV_SECRET_FILE >/dev/null 2>&1'

if ((failures > 0)); then
  docker logs --tail 40 "$name" >&2 || true
  exit 1
fi
echo "check-convex-argv: ok"
