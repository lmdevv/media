#!/usr/bin/env bash
#   scripts/stack-e2e.sh
#   IMAGE=ghcr.io/lmdevv/media:main scripts/stack-e2e.sh   # skip the build
#   QSV=1 scripts/stack-e2e.sh   # with compose.qsv.yaml: Quick Sync on the host's Intel GPU
#
# Env: IMAGE, PROJECT (compose project, default media-e2e), MEDIA_PORT (18080), KEEP=1 to leave
# the stack running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="${PROJECT:-media-e2e}"
port="${MEDIA_PORT:-18080}"
image="${IMAGE:-}"

if [[ -z "$image" ]]; then
  image="media:${project}"
  docker build -f "$root/deploy/image/Dockerfile" -t "$image" "$root"
fi

library="$(mktemp -d)"
node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
# Ten minutes of video, so its transcode still runs when the crash check kills the media service.
mkdir -p "$library/movies/Long Fixture (2020)"
"${FFMPEG_PATH:-ffmpeg}" -hide_banner -nostdin -v error -y -f lavfi \
  -i testsrc2=size=320x180:rate=24:duration=600 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -g 48 "$library/movies/Long Fixture (2020)/Long Fixture (2020).mp4"
# mktemp makes the folder private to this user; the media user (PUID) must read it, as it must
# read any real library.
chmod -R a+rX "$library"

export MEDIA_IMAGE="$image"
export MEDIA_LIBRARY="$library"
export MEDIA_PORT="$port"
export MEDIA_BASE_URL="http://127.0.0.1:${port}"
movies_convex_url="${MEDIA_BASE_URL}/movies/convex"
export PUID="$(id -u)" PGID="$(id -g)"
compose_args=(-p "$project" -f "$root/deploy/compose/compose.yaml")
if [[ "${QSV:-0}" == 1 ]]; then
  compose_args+=(-f "$root/deploy/compose/compose.qsv.yaml")
fi
compose() { docker compose "${compose_args[@]}" "$@"; }

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    compose logs --no-color --tail 120 media >&2 || true
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$library"
  fi
  exit $status
}
trap cleanup EXIT

compose down --volumes --remove-orphans >/dev/null 2>&1 || true
compose up -d --pull missing --no-build

healthy() { curl -fsS "${MEDIA_BASE_URL}/api/health" 2>/dev/null | grep -q '"backend":"connected"'; }
for _ in $(seq 1 120); do
  healthy && break
  sleep 2
done
healthy || { echo "the media service did not become healthy" >&2; exit 1; }

check() {
  if ! eval "$2"; then
    echo "check failed: $1" >&2
    exit 1
  fi
  echo "ok: $1"
}

in_movies() { compose exec -T media "$@"; }
media_pid() {
  in_movies sh -c 'for p in /proc/[0-9]*; do
    case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in node\ --env-file=*) echo "${p#/proc/}";; esac
  done'
}
media_pid="$(media_pid)"
media_uid="$(in_movies awk '/^Uid:/ { print $2 }' "/proc/${media_pid}/status")"
answers() { curl -fsS "${MEDIA_BASE_URL}$1" 2>/dev/null | grep -qF "$2"; }
owners() {
  in_movies sh -c 'for p in /proc/[0-9]*; do
    tr "\0" " " <"$p/cmdline" 2>/dev/null | grep -q "^$0" && stat -c %U "$p"
  done' "$1" | sort -u
}

check "the image publishes one port" \
  '[[ "$(docker port "$(compose ps -q media)" | wc -l)" -le 2 && -z "$(docker port "$(compose ps -q media)" | grep -v "^8080/tcp ")" ]]'
check "/convex is the core's Convex backend" '[[ "$(curl -fsS "${MEDIA_BASE_URL}/convex/instance_name")" == core ]]'
check "/movies/convex is old movies' Convex backend" '[[ "$(curl -fsS "${movies_convex_url}/instance_name")" == movies ]]'
check "/api is the media service" 'answers /api/health "\"backend\":\"connected\""'
check "/ is the account client" 'answers / "<title>[media]</title>"'
check "/movies is the movies client" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "${MEDIA_BASE_URL}/movies")" == "308 ${MEDIA_BASE_URL}/movies/" ]] &&
    answers /movies/ "<title>[movies]</title>" && answers /movies/title/x "/movies/assets/"'
check "the web clients reach Convex on this address" \
  'in_movies grep -rqF "${MEDIA_BASE_URL}/convex" /run/media/account &&
    in_movies grep -rqF "${movies_convex_url}" /run/media/web'
check "Convex HTTP actions stay inside the container" \
  '! curl -fsS "${MEDIA_BASE_URL}/convex/.well-known/jwks.json" 2>/dev/null | grep -qF "\"keys\"" &&
    in_movies curl -fsS http://127.0.0.1:3211/.well-known/jwks.json | grep -qF "\"keys\""'
check "the data root has one folder per domain" '[[ "$(in_movies ls /data | tr "\n" " ")" == "core movies " ]]'
check "each Convex backend runs unprivileged" '[[ "$(owners /app/convex/convex-local-backend)" == convex ]]'
check "Caddy runs unprivileged" '[[ "$(owners "caddy run")" == caddy ]]'
check "no instance secret is on a command line" \
  '! in_movies sh -c "cat /proc/[0-9]*/cmdline 2>/dev/null | tr \"\\0\" \"\\n\" | grep -qxFf /data/core/secrets/instance_secret -f /data/movies/secrets/instance_secret"'

check "the media service runs unprivileged" '[[ -n "$media_pid" && "$media_uid" == "$PUID" && "$media_uid" != 0 ]]'
check "the service environment is private" \
  '[[ "$(in_movies stat -c "%u %a" /run/movies/media.env)" == "$PUID 600" ]]'
check "backups are private" '[[ "$(in_movies stat -c "%a" /data/movies/backups /data/core/backups | sort -u)" == 700 ]]'
check "the library is read-only" '! in_movies setpriv --reuid=0 touch /media/library/written 2>/dev/null'
check "no secret is in the command line" \
  '! in_movies cat "/proc/${media_pid}/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
check "the admin key is not in the web app" \
  '! in_movies sh -c "grep -rqF \"\$(sed -n s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p /run/movies/media.env)\" /run/media /app/web /app/account"'
check "Convex refuses admin calls without the key" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code}" "${movies_convex_url}/api/check_admin_key")" =~ ^40[13]$ &&
    "$(curl -s -o /dev/null -w "%{http_code}" "${MEDIA_BASE_URL}/convex/api/check_admin_key")" =~ ^40[13]$ ]]'

in_movies sh -c "kill $media_pid"
for _ in $(seq 1 60); do
  restarted="$(media_pid)"
  [[ -n "$restarted" && "$restarted" != "$media_pid" ]] && healthy && break
  sleep 1
done
check "s6 restarts the media service when it dies" '[[ -n "$restarted" && "$restarted" != "$media_pid" ]] && healthy'

statuses="$(for _ in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code}\n" "${MEDIA_BASE_URL}/api/health"; done)"
check "a client past its limit through Caddy gets 429" 'grep -qx 429 <<<"$statuses"'
check "the container's health check is never limited" \
  '[[ "$(in_movies curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4300/api/health)" == 200 ]] &&
    [[ "$(docker inspect -f "{{.State.Health.Status}}" "$(compose ps -q media)")" == healthy ]]'
sleep 7
spoofed="$(for _ in $(seq 1 80); do
  curl -s -o /dev/null -w "%{http_code}\n" -H "X-Forwarded-For: 127.0.0.1" "${MEDIA_BASE_URL}/api/health"
done)"
check "a client cannot pass as the install by sending X-Forwarded-For" 'grep -qx 429 <<<"$spoofed"'
sleep 7

pnpm --dir "$root" --filter @lmdevv/movies build >/dev/null

MEDIA_PACKAGED_STACK=1 \
  MEDIA_PACKAGED_CONVEX_URL="$movies_convex_url" \
  MEDIA_PACKAGED_SERVER_URL="$MEDIA_BASE_URL" \
  MEDIA_PACKAGED_LIBRARY=/media/library \
  MEDIA_PACKAGED_RESTART="docker compose ${compose_args[*]} restart media" \
  pnpm --dir "$root" exec vitest run --root "$root" apps/media/src/stack/packaged-stack.test.ts

release="$("$root/scripts/check-version.sh")"
check "the image's CLI reports the release version" '[[ "$(in_movies media --version)" == "$release" ]]'
check "the image's CLI signs in to its own stack" \
  'printf %s stack-test-password | in_movies media login --email owner@movies.test --password >/dev/null'
check "the image's CLI calls its own stack" 'in_movies media whoami | grep -qF "owner@movies.test"'
played="$(in_movies media play "Big Buck Fixture")" ||
  { echo "check failed: the image's CLI plays in its own stack" >&2; exit 1; }
play_url="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).url)' "$played")"
stream_url_without_token="${play_url%%\?*}"
echo "ok: the image's CLI plays in its own stack: ${stream_url_without_token}"
check "the image's CLI plays at the public URL" '[[ "$play_url" == "$MEDIA_BASE_URL/"* ]]'
check "the printed stream URL plays from the host" \
  '[[ "$(curl -fsS -r 0-0 -o /dev/null -w "%{http_code}" "$play_url")" =~ ^20[06]$ ]]'
check "the CLI login is root's and private, in the data volume" \
  '[[ "$(in_movies stat -c "%U %a" /data/movies/config/movies/config.json)" == "root 600" ]]'
retained="$(in_movies media logs --since 5m --json 2>&1)" || true
if ! grep -qF '"message":"Stream.started"' <<<"$retained"; then
  echo "media logs answered $(wc -l <<<"$retained") lines; the last ten:" >&2
  tail -n 10 <<<"$retained" | cut -c1-300 >&2
  in_movies ls -l /data/movies/media/logs >&2 || true
fi
check "the image's CLI reads the retained log as the owner" \
  'grep -qF "\"message\":\"Stream.started\"" <<<"$retained"'
check "the retained log is private to the media user" \
  '[[ "$(in_movies stat -c "%u %a" /data/movies/media/logs)" == "$PUID 700" ]] &&
    ! in_movies find /data/movies/media/logs -type f ! -perm 600 | grep -q .'

running_ffmpeg() {
  in_movies sh -c 'for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = ffmpeg ] && [ "$(cut -d" " -f3 "$p/stat" 2>/dev/null)" != Z ] &&
      echo "${p#/proc/}"
  done' || true
}
in_movies media play "Long Fixture" --max-height 144 >/dev/null ||
  { echo "check failed: the image's CLI transcodes the long fixture" >&2; exit 1; }
check "the media service runs ffmpeg before it crashes" '[[ -n "$(running_ffmpeg)" ]]'
crashed="$(media_pid)"
in_movies sh -c "kill -KILL $crashed"
sleep 1
check "a media service killed with SIGKILL leaves no ffmpeg running a second later" \
  '[[ -z "$(running_ffmpeg)" ]]'
for _ in $(seq 1 60); do
  restarted="$(media_pid)"
  [[ -n "$restarted" && "$restarted" != "$crashed" ]] && healthy && break
  sleep 1
done
check "s6 restarts the media service after it crashes" \
  '[[ -n "$restarted" && "$restarted" != "$crashed" ]] && healthy'

archives() { in_movies sh -c "ls /data/$1/backups | grep -c '^$1-.*\.zip$'" || true; }
before="$(archives movies)"
core_before="$(archives core)"
in_movies sh -c 'echo 0.0.0-previous > /data/movies/version && echo 0.0.0-previous > /data/core/version'
compose restart media >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "an upgrade backs up first" '[[ "$(archives movies)" -gt "$before" ]]'
check "an upgrade of the core backs it up first" '[[ "$(archives core)" -gt "$core_before" ]]'
check "the restarted service keeps its secrets" 'healthy'

check "a deployed upgrade clears its backup marker" '! in_movies test -e /data/movies/upgrade-backup'

after="$(archives movies)"
in_movies sh -c 'cp /data/movies/version /data/movies/upgrade-backup && echo 0.0.0-previous > /data/movies/version'
compose restart media >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "the service is healthy after the retried upgrade" 'healthy'
check "a retried upgrade does not back up again" '[[ "$(archives movies)" -eq "$after" ]]'

# An outer proxy on the container's loopback, as a TLS proxy beside the NixOS module connects:
# 80 requests for one client, then one for another, in one shell so no refill falls between.
through_outer_proxy() {
  in_movies sh -c 'health() { curl -s -o /dev/null -w "%{http_code}\n" -H "X-Forwarded-For: $1" \
    http://127.0.0.1:8080/api/health; }
  for _ in $(seq 1 80); do health 203.0.113.1; done; health 203.0.113.2'
}
outer="$(through_outer_proxy)"
check "an untrusted outer proxy's clients count as one client" \
  'grep -qx 429 <<<"$outer" && [[ "$(tail -n 1 <<<"$outer")" == 429 ]]'
sleep 7
export MEDIA_TRUSTED_PROXIES=127.0.0.1/32
compose up -d --no-build >/dev/null 2>&1
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
outer="$(through_outer_proxy)"
check "a trusted outer proxy's clients each get their own limit" \
  'grep -qx 429 <<<"$outer" && [[ "$(tail -n 1 <<<"$outer")" == 200 ]]'

if [[ "${QSV:-0}" == 1 ]]; then
  check "the media user encodes with Quick Sync in the container" \
    'in_movies setpriv --reuid=movies --regid=movies --init-groups ffmpeg -hide_banner -nostdin \
      -v error -init_hw_device qsv=hw,child_device=/dev/dri/renderD128 -filter_hw_device hw -f lavfi \
      -i testsrc2=size=320x240:rate=10:duration=1 -vf hwupload=extra_hw_frames=16,format=qsv \
      -c:v h264_qsv -f null -'
  check "no transcode fell back from Quick Sync" \
    '! compose logs media | grep -q "HardwareAcceleration.disabled\|encoder_failed"'
fi
