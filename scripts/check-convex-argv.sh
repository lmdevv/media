#!/usr/bin/env bash
# Checks that the NixOS module's Convex container keeps its instance secret off every command line
# (docs/security.md). It runs the pinned Convex image the way nix/module.nix does, with
# nix/convex-entry.sh and the argv-secret shim from the Nix package, then:
#
#   - no process on the host shows the secret in /proc/<pid>/cmdline, while the backend's shows
#     the placeholder;
#   - the backend answers, so the shim handed it the real secret;
#   - `generate_key` through the shim, as the module's setup runs it, derives an admin key the
#     backend accepts;
#   - a restart keeps the secret and puts its file back to 0600 in a 0700 folder.
#
# The check itself never puts a secret in an argument: the secret and the admin key stay in files
# only this user (or the container's root) can read, `grep -F -f` reads them as patterns, and curl
# reads the admin key's header from a file. A watcher scans every host process's command line
# for both while the checks run, and the script fails if it ever saw one.
#
# Needs Docker and Nix. Usage: scripts/check-convex-argv.sh
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"${root}/deploy/convex-backend.image")"
name="check-convex-argv-$$"
package="$(nix build --no-link --print-out-paths "${root}#movies")"
shim="${package}/lib/movies/convex/argv-secret.so"
data="$(mktemp -d)"
work="$(mktemp -d)"
watcher=""

cleanup() {
  [[ -z "$watcher" ]] || kill "$watcher" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run --rm --network none -v "${data}:/d" --entrypoint /bin/sh "$image" -c 'rm -rf /d/*' \
    >/dev/null 2>&1 || true
  rmdir "$data" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

failures=0
check() {
  if eval "$2"; then echo "ok: $1"; else echo "check failed: $1" >&2; failures=$((failures + 1)); fi
}

in_box() { docker exec "$name" sh -c "$1"; }

backend_up() {
  for _ in $(seq 1 60); do
    docker exec "$name" curl -fsS http://127.0.0.1:3210/version >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

docker run -d --name "$name" --network none \
  -e INSTANCE_NAME=core \
  -e CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210 \
  -e CONVEX_SITE_ORIGIN=http://127.0.0.1:3211 \
  -v "${data}:/convex/data" \
  -v "${root}/nix/convex-entry.sh:/media-convex-entry.sh:ro" \
  -v "${shim}:/argv-secret.so:ro" \
  --entrypoint /bin/bash "$image" /media-convex-entry.sh >/dev/null

check "the backend answers" 'backend_up'

# The secret, by redirection only, into a file only this user reads; the watcher's patterns.
in_box 'cat /convex/data/credentials/instance_secret' >"${work}/secret"
cp "${work}/secret" "${work}/patterns"
: >"${work}/seen"

check "the entrypoint made a 32-byte hex secret" "grep -qxE '[0-9a-f]{64}' '${work}/secret'"

# Every 50 ms, which process command lines hold a pattern; it records paths, never what matched.
(
  while :; do
    grep -slaF -f "${work}/patterns" /proc/[0-9]*/cmdline >>"${work}/seen" 2>/dev/null || true
    sleep 0.05
  done
) &
watcher=$!

pid="$(docker inspect -f '{{.State.Pid}}' "$name")"

check "the backend's command line shows the placeholder" \
  'tr "\0" " " <"/proc/${pid}/cmdline" | grep -qF -- "--instance-secret @ARGV_SECRET_FILE"'
check "no command line on the host holds the secret" \
  "! grep -sqaF -f '${work}/secret' /proc/[0-9]*/cmdline"
check "the backend's environment holds no secret, only its file's path" \
  "! in_box 'cat /proc/1/environ' | tr '\\0' '\\n' | grep -qF -f '${work}/secret'"

# The admin key stays in a root-only folder in the container; curl reads its header from a file.
in_box 'mkdir -m 700 -p /tmp/check &&
  LD_PRELOAD=/argv-secret.so ARGV_SECRET_FILE=/convex/data/credentials/instance_secret \
    /convex/generate_key core @ARGV_SECRET_FILE | tail -n 1 >/tmp/check/key &&
  { printf "Authorization: Convex "; cat /tmp/check/key; } >/tmp/check/header &&
  printf "Authorization: Convex core|00not-a-key\n" >/tmp/check/bad'
printf '\n' >>"${work}/patterns"
in_box 'cat /tmp/check/key' >>"${work}/patterns"

admin_status() {
  in_box "curl -s -o /dev/null -w '%{http_code}' -H @/tmp/check/$1 \
    http://127.0.0.1:3210/api/check_admin_key"
}

check "generate_key through the shim derives an admin key the backend accepts" \
  '[[ "$(admin_status header)" == 200 && "$(admin_status bad)" == 401 ]]'
check "the shim refuses a placeholder without its file" \
  '! docker exec -e LD_PRELOAD=/argv-secret.so "$name" /convex/generate_key core @ARGV_SECRET_FILE >/dev/null 2>&1'

# A secret left readable, as an older install may have it, is made private again at the next start.
in_box 'chmod 755 /convex/data/credentials && chmod 644 /convex/data/credentials/instance_secret'
docker restart "$name" >/dev/null

check "a restart serves the same secret again" \
  "backend_up && in_box 'cat /convex/data/credentials/instance_secret' | cmp -s - '${work}/secret'"
check "a restart makes the secret 0600 in a 0700 folder" \
  "[[ \"\$(in_box 'stat -c %a /convex/data/credentials /convex/data/credentials/instance_secret' |
    tr '\\n' ' ')\" == '700 600 ' ]]"

kill "$watcher" 2>/dev/null || true
wait "$watcher" 2>/dev/null || true
watcher=""

check "no command line held the secret or the admin key while the checks ran" \
  "[[ ! -s '${work}/seen' ]]"

if ((failures > 0)); then
  docker logs --tail 40 "$name" >&2 || true
  exit 1
fi
echo "check-convex-argv: ok"
