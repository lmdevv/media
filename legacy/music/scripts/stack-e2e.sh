#!/usr/bin/env bash
# Builds the image, starts a fresh container with a music library, and runs the real-stack
# end-to-end suite (apps/web/e2e-stack) against it.
#
#   scripts/stack-e2e.sh                 # generated fixture library
#   MUSIC_DIR=~/music scripts/stack-e2e.sh
#
# Env: IMAGE (skip the build and use this image), PORT (default 8090), NAME (container name,
# default music-stack-e2e), CHROMIUM_PATH, KEEP=1 to leave the container running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
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

# Secrets, the database, and backups are private to root inside the container.
modes="$(docker exec "$name" stat -c '%a %n' /data/secrets /data/secrets/instance_secret \
  /data/secrets/admin_key /data/secrets/media_secret /data/convex /data/backups)"
echo "$modes"
if grep -Ev '^(700|600) ' <<<"$modes"; then
  echo "secrets or data are readable beyond root" >&2
  exit 1
fi

# The admin key never reaches the web app, and the Convex admin API refuses callers without it.
if docker exec "$name" sh -c 'grep -rlF "$(cat /data/secrets/admin_key)" /app/web'; then
  echo "the admin key is in the web app" >&2
  exit 1
fi
admin_status="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/convex/api/check_admin_key")"
if [[ "$admin_status" != "403" ]]; then
  echo "the Convex admin API answered $admin_status without a key" >&2
  exit 1
fi

wait_healthy() {
  for _ in $(seq 1 120); do
    curl -fsS "http://localhost:${port}/media/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  docker logs "$name" | tail -50
  return 1
}

# The media service, which runs ffmpeg on every library file, is not root: it runs as the `music`
# user (PUID, 1000 by default), cannot read the secrets or the database, and owns /data/media.
media_check() {
  local pid uid
  pid="$(docker exec "$name" sh -c 'for p in /proc/[0-9]*; do
    [ "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" = "node dist/main.js " ] && echo "${p#/proc/}"
  done; true')"
  uid="$(docker exec "$name" awk '/^Uid:/ { print $2 }' "/proc/$pid/status")"
  echo "media service: pid $pid, uid $uid"
  if [[ -z "$pid" || "$uid" != "$(docker exec "$name" id -u music)" || "$uid" == 0 ]]; then
    echo "the media service does not run as the music user" >&2
    return 1
  fi
  for path in /data/secrets/admin_key /data/secrets/instance_secret /data/convex/db.sqlite3; do
    if docker exec -u "$uid" "$name" cat "$path" >/dev/null 2>&1; then
      echo "the media user can read $path" >&2
      return 1
    fi
  done
  docker exec -u "$uid" "$name" cat /run/music/media.env >/dev/null
  if [[ "$(docker exec "$name" stat -c '%U %a' /run/music/media.env)" != "music 600" ]]; then
    echo "/run/music/media.env is not private to the media user" >&2
    return 1
  fi
  if [[ -n "$(docker exec "$name" find /data/media \! -user music)" ]]; then
    echo "/data/media has files the media user does not own" >&2
    return 1
  fi
}

media_check

# Upgrading in place: an install whose media service ran as root left root-owned files behind.
docker exec "$name" sh -c 'mkdir -p /data/media/cache/old && touch /data/media/cache/old/f /data/media/f'
docker restart "$name" >/dev/null
wait_healthy
media_check

MUSIC_URL="http://localhost:${port}" pnpm --dir "$root" --filter web test:stack

# Scanning and streaming ran as the media user too: art and transcodes are its own.
media_check
if [[ -z "$(docker exec "$name" find /data/media/art /data/media/cache -type f -user music)" ]]; then
  echo "the suite left no art or transcodes in /data/media" >&2
  exit 1
fi
