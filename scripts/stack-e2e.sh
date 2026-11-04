#!/usr/bin/env bash
# Packaged-stack smoke test: builds the image, starts deploy/compose/compose.yaml on a fresh
# project with a generated fixture library mounted read-only, checks the install's privilege and
# secret boundaries, then runs apps/media/src/stack/packaged-stack.test.ts against it (sign-up,
# library, scan, direct and HLS playback, a media restart, CLI backup and restore) and the image's
# own `media` CLI.
#
#   scripts/stack-e2e.sh
#   IMAGE=ghcr.io/lmdevv/media:main scripts/stack-e2e.sh   # skip the build
#   QSV=1 scripts/stack-e2e.sh   # with compose.qsv.yaml: Quick Sync on the host's Intel GPU
#
# Env: IMAGE, PROJECT (compose project, default movies-e2e), MEDIA_PORT (18080), CONVEX_PORT
# (18210), KEEP=1 to leave the stack running afterwards.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="${PROJECT:-movies-e2e}"
movies_port="${MEDIA_PORT:-18080}"
convex_port="${CONVEX_PORT:-18210}"
image="${IMAGE:-}"

if [[ -z "$image" ]]; then
  image="movies:${project}"
  docker build -f "$root/deploy/compose/Dockerfile" -t "$image" "$root"
fi

library="$(mktemp -d)"
node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
# mktemp makes the folder private to this user; the media user (PUID) must read it, as it must
# read any real library.
chmod -R a+rX "$library"

export MEDIA_IMAGE="$image"
export MEDIA_LIBRARY="$library"
export MEDIA_PORT="$movies_port"
export CONVEX_PORT="$convex_port"
export MEDIA_BASE_URL="http://127.0.0.1:${movies_port}"
export CONVEX_PUBLIC_URL="http://127.0.0.1:${convex_port}"
export PUID="$(id -u)" PGID="$(id -g)"
compose_args=(-p "$project" -f "$root/deploy/compose/compose.yaml")
if [[ "${QSV:-0}" == 1 ]]; then
  compose_args+=(-f "$root/deploy/compose/compose.qsv.yaml")
fi
compose() { docker compose "${compose_args[@]}" "$@"; }

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    compose logs --no-color --tail 80 movies convex >&2 || true
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

in_movies() { compose exec -T movies "$@"; }
media_pid="$(in_movies sh -c 'for p in /proc/[0-9]*; do
  case "$(tr "\0" " " < "$p/cmdline" 2>/dev/null)" in node\ --env-file=*) echo "${p#/proc/}";; esac
done')"
media_uid="$(in_movies awk '/^Uid:/ { print $2 }' "/proc/${media_pid}/status")"

check "the media service runs unprivileged" '[[ -n "$media_pid" && "$media_uid" == "$PUID" && "$media_uid" != 0 ]]'
check "the service environment is private" \
  '[[ "$(in_movies stat -c "%u %a" /run/movies/media.env)" == "$PUID 600" ]]'
check "backups are private" '[[ "$(in_movies stat -c "%a" /data/backups)" == 700 ]]'
check "the library is read-only" '! in_movies setpriv --reuid=0 touch /media/library/written 2>/dev/null'
check "no secret is in the command line" \
  '! in_movies cat "/proc/${media_pid}/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
check "the admin key is not in the web app" \
  '! in_movies sh -c "grep -rqF \"\$(sed -n s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p /run/movies/media.env)\" /run/movies/web /app/web"'
check "Convex refuses admin calls without the key" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code}" "${CONVEX_PUBLIC_URL}/api/check_admin_key")" =~ ^40[13]$ ]]'

pnpm --dir "$root" --filter @lmdevv/movies build >/dev/null

MEDIA_PACKAGED_STACK=1 \
  MEDIA_PACKAGED_CONVEX_URL="$CONVEX_PUBLIC_URL" \
  MEDIA_PACKAGED_SERVER_URL="$MEDIA_BASE_URL" \
  MEDIA_PACKAGED_LIBRARY=/media/library \
  MEDIA_PACKAGED_RESTART="docker compose ${compose_args[*]} restart movies" \
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
  '[[ "$(in_movies stat -c "%U %a" /data/config/movies/config.json)" == "root 600" ]]'
retained="$(in_movies media logs --since 5m --json 2>&1)" || true
if ! grep -qF '"message":"Stream.started"' <<<"$retained"; then
  echo "media logs answered $(wc -l <<<"$retained") lines; the last ten:" >&2
  tail -n 10 <<<"$retained" | cut -c1-300 >&2
  in_movies ls -l /data/media/logs >&2 || true
fi
check "the image's CLI reads the retained log as the owner" \
  'grep -qF "\"message\":\"Stream.started\"" <<<"$retained"'
check "the retained log is private to the media user" \
  '[[ "$(in_movies stat -c "%u %a" /data/media/logs)" == "$PUID 700" ]] &&
    ! in_movies find /data/media/logs -type f ! -perm 600 | grep -q .'

archives() { in_movies sh -c 'ls /data/backups | grep -c "^movies-.*\.zip$"' || true; }
before="$(archives)"
in_movies sh -c 'echo 0.0.0-previous > /data/version'
compose restart movies >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "an upgrade backs up first" '[[ "$(archives)" -gt "$before" ]]'
check "the restarted service keeps its secrets" 'healthy'

check "a deployed upgrade clears its backup marker" '! in_movies test -e /data/upgrade-backup'

after="$(archives)"
in_movies sh -c 'cp /data/version /data/upgrade-backup && echo 0.0.0-previous > /data/version'
compose restart movies >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "the service is healthy after the retried upgrade" 'healthy'
check "a retried upgrade does not back up again" '[[ "$(archives)" -eq "$after" ]]'

if [[ "${QSV:-0}" == 1 ]]; then
  check "the media user encodes with Quick Sync in the container" \
    'in_movies setpriv --reuid=movies --regid=movies --init-groups ffmpeg -hide_banner -nostdin \
      -v error -init_hw_device qsv=hw,child_device=/dev/dri/renderD128 -filter_hw_device hw -f lavfi \
      -i testsrc2=size=320x240:rate=10:duration=1 -vf hwupload=extra_hw_frames=16,format=qsv \
      -c:v h264_qsv -f null -'
  check "no transcode fell back from Quick Sync" \
    '! compose logs movies | grep -q "HardwareAcceleration.disabled\|encoder_failed"'
fi
