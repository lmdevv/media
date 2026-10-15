#!/usr/bin/env bash
# Proves an upgrade and a rollback on one data volume, as a homelab would do them:
#
#   1. A released image (OLD_IMAGE, default ghcr.io/lmdevv/music:0.1.0; CI also runs 0.2.0, the
#      release before this one) starts on an empty
#      volume; an admin signs up, adds the fixture library, waits for its scan, makes a
#      playlist, and queues songs on a device.
#   2. The new image (IMAGE, built from this checkout unless set) starts on the same volume. It
#      must back up before deploying, run the data migrations (0.1.0 predates accent-folded
#      search, so "doppelganger" only finds "Doppelgänger" once they ran, and stored the queue on
#      the playback session, which splitPlaybackQueues moves to a row of its own), claim the
#      library's folder so its songs stream again, and keep every account, song, playlist, and
#      queue, with the same password still signing in.
#   3. Going back without restoring is refused: with /data/version newer than the image, init
#      stops before exporting or deploying anything.
#   4. The documented rollback: /app/bin/restore puts back the pre-upgrade backup while the new
#      image runs and records the version that wrote it, then the old image must come up healthy
#      with the same data.
#
#   scripts/upgrade-e2e.sh
#   IMAGE=music:dev PORT=8091 scripts/upgrade-e2e.sh
#
# Env: OLD_IMAGE, IMAGE, PORT (default 8090), NAME (default music-upgrade-e2e), KEEP=1 to leave
# the container and volume behind.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/stack.sh
source "$root/scripts/lib/stack.sh"
port="${PORT:-8090}"
name="${NAME:-music-upgrade-e2e}"
# The 0.1.0 release, pinned by digest like nix/vm-test.nix.
old_image="${OLD_IMAGE:-ghcr.io/lmdevv/music:0.1.0@sha256:8eeaa3b3808b72ab97ac787cf547b69359bd214f0dd5cc86b216cc76f9c152eb}"
# The old release's version, from its tag (ghcr.io/lmdevv/music:0.2.0@sha256:… gives 0.2.0).
old_version="${old_image#*music:}"
old_version="${old_version%%@*}"
[[ "$old_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "upgrade e2e: OLD_IMAGE must be tagged with a release version, got $old_image" >&2
  exit 1
}
image="${IMAGE:-}"
url="http://localhost:${port}"
email="upgrade@music.test"
password="upgrade-password-1"

if [[ -z "$image" ]]; then
  image="music:${name#music-}"
  docker build -f "$root/deploy/docker/Dockerfile" -t "$image" "$root"
fi
docker pull -q "$old_image" >/dev/null

library="$(mktemp -d)"
node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
chmod -R a+rX "$library"

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$name-data" >/dev/null 2>&1 || true
  fi
  rm -rf "$library"
}
trap cleanup EXIT

fail() {
  echo "upgrade e2e: $*" >&2
  docker logs "$name" 2>&1 | tail -40 >&2 || true
  exit 1
}

start() {
  # Stopped the way an upgrade would stop it, so Convex shuts down cleanly first.
  docker stop -t 60 "$name" >/dev/null 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:${port}:8080" -v "$name-data:/data" \
    -v "$library:/music:ro" -e PUBLIC_URL="$url" "$1" >/dev/null
  # Earlier images answered /healthz from Caddy alone, so wait for the media service too.
  for _ in $(seq 1 150); do
    if curl -fsS "$url/healthz" >/dev/null 2>&1 && curl -fsS "$url/media/health" >/dev/null 2>&1; then
      echo "$1 is up"
      return 0
    fi
    sleep 2
  done
  fail "$1 did not become healthy"
}

# Prints the JSON field path $2 (like .value.tokens.token) of the JSON on stdin.
field() {
  node -e '
    let value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    for (const key of process.argv[1].split(".").filter(Boolean)) value = value?.[key];
    if (value === undefined) { console.error("missing", process.argv[1]); process.exit(1); }
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1"
}

# Calls the Convex HTTP API: kind (query, mutation, action), function path, JSON args.
call() {
  curl -fsS -X POST "$url/convex/api/$1" -H 'Content-Type: application/json' \
    ${token:+-H "Authorization: Bearer $token"} \
    -d "{\"path\":\"$2\",\"format\":\"json\",\"args\":$3}"
}

sign_in() {
  call action auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$email\",\"password\":\"$password\",\"flow\":\"$1\",\"name\":\"Upgrade\"}}" |
    field .value.tokens.token
}

run_command() { call "$1" "commands:$2" "{\"name\":\"$3\",\"args\":$4}"; }


snapshot() {
  echo "users=$(convex_rows users) tracks=$(convex_rows tracks) albums=$(convex_rows albums) playlists=$(convex_rows playlists) playlistItems=$(convex_rows playlistItems) libraries=$(convex_rows libraries)"
}


# The signed-in user's queue as `<track ids>@<index>`, the same in every version's playback.state.
queue_of() {
  run_command query read playback.state '{}' | field .value |
    node -pe 'const s = JSON.parse(require("node:fs").readFileSync(0, "utf8")); `${s.queue.map((t) => t.id).join(",")}@${s.index}`'
}

search_titles() {
  run_command query read search "{\"query\":\"$1\"}" | field .value.tracks |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).map((t) => t.title).join(",")'
}

# 1. The released image, with an admin, a scanned library, and a playlist.
start "$old_image"
token="$(sign_in signUp)"
job="$(run_command mutation run libraries.create '{"name":"Music","path":"/music"}' | field .value.jobId)"
for _ in $(seq 1 90); do
  status="$(run_command query read jobs.get "{\"jobId\":\"$job\"}" | field .value.status)"
  [[ "$status" == "done" ]] && break
  [[ "$status" == "failed" || "$status" == "cancelled" ]] && fail "the scan ended $status"
  sleep 2
done
[[ "$status" == "done" ]] || fail "the scan did not finish"
tracks="$(run_command query read tracks.list '{"limit":3}' | field .value.items)"
track_ids="$(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).map((t) => t.id))' "$tracks")"
run_command mutation run playlists.create "{\"name\":\"Before the upgrade\",\"trackIds\":$track_ids}" >/dev/null
# A queue on a device: 0.1.0 stores it on the playback session row, which the
# splitPlaybackQueues migration moves into a playbackQueues row of its own.
run_command mutation run devices.heartbeat \
  '{"deviceId":"upgrade-e2e","name":"Upgrade test","kind":"web"}' >/dev/null
run_command mutation run playback.play \
  "{\"trackIds\":$track_ids,\"index\":1,\"deviceId\":\"upgrade-e2e\"}" >/dev/null
run_command mutation run playback.pause '{}' >/dev/null
queue_before="$(queue_of)"
echo "queue before the upgrade: $queue_before"
[[ "$queue_before" == *"@1" ]] || fail "the old image did not keep the queue"
if [[ "$old_version" == "0.1.0" ]]; then
  convex_data playbackSessions | grep -q '"queue"' || fail "0.1.0 did not store the queue on the session"
fi
before="$(snapshot)"
echo "before the upgrade: $before"
[[ "$before" != *"tracks=0"* && "$before" == *"playlists=1"* ]] || fail "the old image did not set up"

# 2. The new image on the same volume.
start "$image"
mapfile -t backups < <(docker exec "$name" sh -c 'ls -1t /data/backups | grep "^pre-.*\.zip$"' || true)
echo "backups: ${backups[*]:-none}"
[[ "${#backups[@]}" == 1 ]] || fail "expected one backup before the upgrade, got ${#backups[@]}"
[[ "$(docker exec "$name" cat /data/build)" == "$(docker exec "$name" cat /app/build-id)" ]] ||
  fail "the new build is not recorded"
after="$(snapshot)"
echo "after the upgrade: $after"
[[ "$after" == "$before" ]] || fail "data changed in the upgrade: $before -> $after"
token="$(sign_in signIn)"
for _ in $(seq 1 30); do
  found="$(search_titles doppelganger)"
  [[ "$found" == *"Doppelgänger"* ]] && break
  sleep 2
done
echo "search doppelganger: ${found:-nothing}"
[[ "$found" == *"Doppelgänger"* ]] || fail "the accent-folding migration did not run"
[[ "$(run_command query read playlists.list '{}' | field .value)" == *"Before the upgrade"* ]] ||
  fail "the playlist is gone"
# The migrations run in the background after the deploy: wait for the queue to move.
for _ in $(seq 1 30); do
  [[ "$(convex_rows playbackQueues)" == 1 ]] && ! convex_data playbackSessions | grep -q '"queue"' && break
  sleep 2
done
echo "playbackQueues rows: $(convex_rows playbackQueues); session keeps a queue: $(convex_data playbackSessions | grep -c '"queue"' || true)"
[[ "$(convex_rows playbackQueues)" == 1 ]] || fail "the splitPlaybackQueues migration did not move the queue"
convex_data playbackSessions | grep -q '"queue"' && fail "the session still holds the old queue"
queue_after="$(queue_of)"
echo "queue after the upgrade: $queue_after"
[[ "$queue_after" == "$queue_before" ]] || fail "the queue changed in the upgrade: $queue_after"
# The library claims its folder after the upgrade (a quick pass ahead of any scan), and only then
# streams: a signed URL must come back and the media service must serve it.
first_track="$(node -pe 'JSON.parse(process.argv[1])[0]' "$track_ids")"
for _ in $(seq 1 30); do
  stream="$(run_command query read stream.url "{\"trackId\":\"$first_track\",\"profile\":\"original\",\"requestedAt\":$(date +%s%3N)}" 2>/dev/null | field .value.url 2>/dev/null || true)"
  [[ "$stream" == /* ]] && stream="$url$stream"
  [[ -n "$stream" ]] && curl -fsS -o /dev/null -r 0-1023 "$stream" && break
  stream=""
  sleep 2
done
echo "stream after the upgrade: ${stream:+served}"
[[ -n "$stream" ]] || fail "songs do not stream after the upgrade"

new_version="$(docker exec "$name" cat /data/version)"
[[ "${backups[0]}" == *"-from-$old_version-"* ]] || fail "the backup does not record the version it came from"

# 3. Older code over newer data is refused. A newer release than this image is emulated by
#    writing its version, as starting it would; init must stop before it exports or deploys.
docker exec "$name" sh -c 'echo 99.0.0 > /data/version'
docker restart "$name" >/dev/null
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == "false" ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Running}}' "$name")" == "false" ]] ||
  fail "the image started on data from a newer version"
refused_backups="$(docker run --rm -v "$name-data:/data" --entrypoint sh "$image" -c \
  'ls /data/backups | grep -c "^pre-.*\.zip$"; cat /data/version')"
echo "after starting on newer data: container stopped; backups and /data/version: $(echo $refused_backups)"
[[ "$refused_backups" == $'1\n99.0.0' ]] || fail "the refused start changed /data: $refused_backups"
if docker logs "$name" 2>&1 | grep -q "refusing to start"; then
  docker logs "$name" 2>&1 | grep "refusing to start" | tail -n 1
fi
# The newer release starting again (emulated) puts its version back, and this image, which
# equals it, starts.
docker run --rm -v "$name-data:/data" --entrypoint sh "$image" -c "echo $new_version > /data/version"
start "$image"

# 4. Roll back as documented: restore the pre-upgrade backup while the new image runs, which
#    also records that its data is the old release's, then run the old image again.
docker exec "$name" /app/bin/restore "/data/backups/${backups[0]}" | grep "\[restore\]"
[[ "$(docker exec "$name" cat /data/version)" == "$old_version" ]] ||
  fail "restore did not record the backup's version"
start "$old_image"
rolled_back="$(snapshot)"
echo "after the rollback: $rolled_back"
[[ "$rolled_back" == "$before" ]] || fail "the rollback did not restore the data: $rolled_back"
token="$(sign_in signIn)"
[[ "$(run_command query read playlists.list '{}' | field .value)" == *"Before the upgrade"* ]] ||
  fail "the playlist is gone after the rollback"
[[ "$(queue_of)" == "$queue_before" ]] || fail "the queue is gone after the rollback"
echo "upgrade e2e passed"
