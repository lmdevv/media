#!/usr/bin/env bash
# Builds the image, starts a fresh container with a music library, checks how it is put together
# (privileges, secrets, health, backups on upgrade), and runs the real-stack end-to-end suite
# (apps/web/e2e-stack) against it.
#
#   scripts/stack-e2e.sh                 # generated fixture library
#   MUSIC_DIR=~/music scripts/stack-e2e.sh
#
# Env: IMAGE (skip the build and use this image), PORT (default 8090), NAME (container name,
# default music-stack-e2e), CHROMIUM_PATH, KEEP=1 to leave the container running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/stack.sh
source "$root/scripts/lib/stack.sh"
port="${PORT:-8090}"
name="${NAME:-music-stack-e2e}"
image="${IMAGE:-}"

if [[ -z "$image" ]]; then
  image="music:${name#music-}"
  docker build -f "$root/deploy/docker/Dockerfile" -t "$image" "$root"
fi

library="${MUSIC_DIR:-}"
if [[ -z "$library" ]]; then
  library="$(mktemp -d)"
  node "$root/apps/media/scripts/generate-fixtures.ts" "$library"
  # mktemp makes the folder private to this user; the unprivileged media user (PUID) must read it,
  # as it must read any real music folder.
  chmod -R a+rX "$library"
fi

pnpm --dir "$root" --filter @music/cli build

docker rm -f "$name" >/dev/null 2>&1 || true
docker volume rm "$name-data" >/dev/null 2>&1 || true
# TZ as a homelab sets it: Convex refuses to start with TZ set unless its run script unsets it.
docker run -d --name "$name" -p "127.0.0.1:${port}:8080" -v "$name-data:/data" -e TZ=Europe/Berlin \
  -v "$library:/music:ro" -e PUBLIC_URL="http://localhost:${port}" "$image" >/dev/null

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$name-data" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "$*" >&2
  exit 1
}

in_container() { docker exec "$name" sh -c "$@"; }

# /healthz answers 200 only while Caddy, the media service, and Convex all do.
wait_healthy() {
  for _ in $(seq 1 120); do
    curl -fsS "http://localhost:${port}/healthz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  docker logs "$name" | tail -50
  return 1
}

wait_healthy

# Secrets and backups are private to root, and the database to the Convex user.
modes="$(docker exec "$name" stat -c '%a %U %n' /data/secrets /data/secrets/instance_secret \
  /data/secrets/admin_key /data/secrets/media_secret /data/backups /data/convex \
  /data/convex/db.sqlite3)"
echo "$modes"
if grep -Ev '^(700|600) (root /data/(secrets|backups)|convex /data/convex)' <<<"$modes"; then
  fail "secrets or data are readable beyond their owner"
fi

# The admin key never reaches the web app, and the Convex admin API refuses callers without it.
if in_container 'grep -rlF "$(cat /data/secrets/admin_key)" /app/web'; then
  fail "the admin key is in the web app"
fi
admin_status="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/convex/api/check_admin_key")"
if [[ "$admin_status" != "403" ]]; then
  fail "the Convex admin API answered $admin_status without a key"
fi

# Caddy must not cut a media stream the browser has stopped reading (buffered far enough ahead,
# or paused): its server-wide write_idle (1m by default) is off, streams get an hour per stalled
# write, and every other route keeps one minute. Checked on the adapted config, since a real
# stall needs a response larger than the socket buffers and a minute of waiting.
docker exec "$name" caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null | node -e '
  const server = JSON.parse(require("node:fs").readFileSync(0, "utf8")).apps.http.servers.srv0;
  const limits = new Map(server.routes.flatMap((route) =>
    (route.handle ?? []).filter((h) => h.handler === "timeouts")
      .map((h) => [JSON.stringify(route.match), h.write_timeout])));
  const hour = 3600e9, minute = 60e9;
  const ok = server.write_idle_timeout < 0 &&
    limits.get(JSON.stringify([{ path: ["/media/stream/*"] }])) === hour &&
    limits.get(JSON.stringify([{ not: [{ path: ["/media/stream/*"] }] }])) === minute;
  if (!ok) { console.error("Caddy write timeouts are not as expected", server.write_idle_timeout, [...limits]); process.exit(1); }
'

# The pids whose command line starts with $1.
pids_of() {
  docker exec "$name" sh -c 'for p in /proc/[0-9]*; do
    case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in "$1"*) echo "${p#/proc/}" ;; esac
  done; true' sh "$1"
}

uid_of() { docker exec "$name" awk '/^Uid:/ { print $2 }' "/proc/$1/status"; }

# No service runs as root: Caddy, Convex, and the media service each run as their own user.
services_check() {
  local service prefix pid uid
  for service in caddy convex music; do
    case "$service" in
      caddy) prefix="caddy run " ;;
      convex) prefix="/app/convex/convex-local-backend " ;;
      music) prefix="node dist/main.js" ;;
    esac
    pid="$(pids_of "$prefix")"
    [[ -n "$pid" && "$pid" != *$'\n'* ]] || fail "expected one $service process, got: ${pid:-none}"
    uid="$(uid_of "$pid")"
    echo "$service: pid $pid, uid $uid"
    if [[ "$uid" == 0 || "$uid" != "$(docker exec "$name" id -u "$service")" ]]; then
      fail "the $service process runs as uid $uid, not as the $service user"
    fi
  done
}

# The media service, which runs ffmpeg on every library file, cannot read the secrets or the
# database, and owns /data/media.
media_check() {
  local uid
  uid="$(docker exec "$name" id -u music)"
  for path in /data/secrets/admin_key /data/secrets/instance_secret /data/convex/db.sqlite3 \
    /run/convex/instance_secret; do
    if docker exec -u "$uid" "$name" cat "$path" >/dev/null 2>&1; then
      fail "the media user can read $path"
    fi
  done
  docker exec -u "$uid" "$name" cat /run/music/media.env >/dev/null
  if [[ "$(docker exec "$name" stat -c '%U %a' /run/music/media.env)" != "music 600" ]]; then
    fail "/run/music/media.env is not private to the media user"
  fi
  if [[ -n "$(docker exec "$name" find /data/media \! -user music)" ]]; then
    fail "/data/media has files the media user does not own"
  fi
  if [[ -n "$(docker exec "$name" find /data/convex \! -user convex)" ]]; then
    fail "/data/convex has files the Convex user does not own"
  fi
}

# Every process can read every other's command line, and a process's environment is readable by
# its own user. Neither may give the media user the instance secret or the admin key, which would
# make it a Convex admin. The secrets reach the scan through stdin and a file, never an argument.
secrets_check() {
  local uid found
  uid="$(docker exec "$name" id -u music)"
  # One secret per line: the instance secret file has no trailing newline. The scan refuses to
  # run with anything but two long patterns, since an empty one would match everything and a
  # merged one nothing.
  found="$(docker exec "$name" sh -c 'for f in instance_secret admin_key; do
      cat "/data/secrets/$f"; echo; done' \
    | docker exec -i -u "$uid" "$name" sh -c 'patterns="$(mktemp)"; grep -v "^$" > "$patterns"
      if [ "$(grep -c "^.\{32,\}$" "$patterns")" != 2 ] || [ "$(wc -l < "$patterns")" != 2 ]; then
        echo "bad patterns"; exit
      fi
      for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do
        grep -qaFf "$patterns" "$f" 2>/dev/null && echo "$f"
      done; rm -f "$patterns"
      # The scan can only pass by reading: it must see the Convex process'"'"'s placeholder.
      grep -qaF @ARGV_SECRET_FILE /proc/[0-9]*/cmdline 2>/dev/null || echo "an unreadable /proc"
      true')"
  if [[ -n "$found" ]]; then
    fail "the media user can read a secret in: $found"
  fi
  echo "no secret in any /proc/*/cmdline or /proc/*/environ the media user can read"
}

backups() { in_container 'ls -1t /data/backups | grep "^pre-.*\.zip$" || true'; }

services_check
media_check
secrets_check

# A first boot records its build and has nothing to back up.
[[ "$(in_container 'cat /data/build')" == "$(in_container 'cat /app/build-id')" ]] ||
  fail "/data/build does not record the image's build"
[[ -z "$(backups)" ]] || fail "a first boot took a backup: $(backups)"

# /healthz reflects the media service and Convex, not only Caddy.
curl -fsS "http://localhost:${port}/healthz" | grep -q '"ok":true' || fail "/healthz is not ok"
docker exec "$name" /command/s6-svc -d /run/service/media
health_down=200
for _ in $(seq 1 50); do
  health_down="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/healthz")"
  [[ "$health_down" == "200" ]] || break
  sleep 0.2
done
docker exec "$name" /command/s6-svc -u /run/service/media
[[ "$health_down" != "200" ]] || fail "/healthz answered 200 with the media service down"
echo "/healthz with the media service down: $health_down"
wait_healthy

# s6 stops Convex with SIGINT, its down-signal, on which it drains requests and shuts the database
# down before exiting. SIGTERM, s6's default, kills it on the spot. Convex 1.46 sometimes aborts
# after it logged "Database shutdown ... Done", when a JavaScript isolate thread outlives the Tokio
# runtime ("A Tokio 1.x context was found, but it is being shutdown"), so 0 and SIGABRT both mean
# the database was closed first; a kill by SIGTERM or SIGKILL means it wasn't.
docker exec "$name" /command/s6-svc -d /run/service/convex
for _ in $(seq 1 100); do
  [[ "$(docker exec "$name" /command/s6-svstat -o up /run/service/convex)" == "false" ]] && break
  sleep 0.1
done
convex_exit="$(docker exec "$name" /command/s6-svstat -o exitcode,signal /run/service/convex)"
docker exec "$name" /command/s6-svc -u /run/service/convex
echo "Convex stopped with: $convex_exit"
[[ "$convex_exit" == "0 NA" || "$convex_exit" == "-1 SIGABRT" ]] ||
  fail "Convex was killed instead of shutting down when stopped: $convex_exit"
wait_healthy

# Upgrading in place from an image that recorded only /data/version, ran the media service and
# Convex as root (leaving root-owned files behind), and has older backups lying around: the boot
# exports a backup before deploying, keeps the newest BACKUP_KEEP (5), and fixes ownership.
in_container 'mkdir -p /data/media/cache/old && touch /data/media/cache/old/f /data/media/f \
  && touch /data/convex/storage/root-owned \
  && rm /data/build && echo 0.0.1 > /data/version \
  && for day in 1 2 3 4 5 6; do
       touch -d "2020-01-0$day" "/data/backups/pre-0.0.$day-old-2020010${day}000000.zip"
     done'
docker restart "$name" >/dev/null
wait_healthy
services_check
media_check
secrets_check
mapfile -t kept < <(backups)
printf 'backups after the upgrade: %s\n' "${kept[*]}"
[[ "${#kept[@]}" == 5 ]] || fail "expected the newest 5 backups, got ${#kept[@]}"
[[ "${kept[0]}" == "pre-$(in_container 'node -p "require(\"/app/backend/package.json\").version"')-$(in_container 'cat /app/build-id')-"* ]] ||
  fail "the upgrade did not export a backup first: ${kept[0]}"
[[ "${kept[4]}" == "pre-0.0.3-old-20200103000000.zip" ]] || fail "pruned the wrong backups"
[[ "$(in_container "head -c 2 /data/backups/${kept[0]}")" == "PK" ]] || fail "the backup is not a zip"
[[ "$(in_container 'cat /data/build')" == "$(in_container 'cat /app/build-id')" ]] ||
  fail "the upgrade did not record the new build"
in_container '! [ -e /data/backups/.pending ]' || fail "the finished upgrade left .pending behind"

# The suite runs the container's Convex CLI to import rows the app cannot create, such as a device
# last seen weeks ago, and to run cron functions on demand.
MUSIC_URL="http://localhost:${port}" MUSIC_CONTAINER="$name" pnpm --dir "$root" --filter web test:stack

# Scanning and streaming ran as the media user too: art and transcodes are its own.
media_check
if [[ -z "$(docker exec "$name" find /data/media/art /data/media/cache -type f -user music)" ]]; then
  fail "the suite left no art or transcodes in /data/media"
fi

# Stopping and starting the same image keeps the data and takes no new backup.
users_before="$(convex_rows users)"
stop_started=$SECONDS
docker stop -t 30 "$name" >/dev/null
stop_seconds=$((SECONDS - stop_started))
echo "docker stop took ${stop_seconds}s"
# s6 gives up on the services after 8 seconds, inside Docker's default 10-second timeout.
[[ "$stop_seconds" -lt 10 ]] || fail "docker stop took ${stop_seconds}s; the default timeout would kill it"
docker start "$name" >/dev/null
wait_healthy
services_check
users_after="$(convex_rows users)"
echo "users before the restart: $users_before, after: $users_after"
[[ "$users_before" -gt 0 && "$users_before" == "$users_after" ]] || fail "users did not survive a restart"
[[ "$(backups | head -n 1)" == "${kept[0]}" ]] || fail "a restart of the same build took a backup"

# A rollback to an image from before the build identity rewrites /data/version on every boot and
# leaves /data/build alone. Coming back to this build afterwards must back up again, even though
# an earlier boot of the same upgrade left a .pending note, since the backup it names is gone.
in_container 'sleep 1 && echo 0.1.0 > /data/version && printf "%s\n%s\n" \
  "version 0.1.0 -> $(cat /app/build-id)" /data/backups/pre-deleted.zip > /data/backups/.pending'
docker restart "$name" >/dev/null
wait_healthy
mapfile -t after_rollback < <(backups)
printf 'backups after a rollback and back: %s\n' "${after_rollback[*]}"
[[ "${after_rollback[0]}" != "${kept[0]}" && "${#after_rollback[@]}" == 5 ]] ||
  fail "returning from a rollback to an older image did not back up first"

# Docker's own health check agrees.
for _ in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" == "healthy" ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" == "healthy" ]] ||
  fail "Docker reports the container $(docker inspect -f '{{.State.Health.Status}}' "$name")"
echo "stack e2e passed"
