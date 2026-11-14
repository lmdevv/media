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

release="$("$root/scripts/check-version.sh")"
if [[ -z "$image" ]]; then
  image="media:${project}"
  docker build -f "$root/deploy/image/Dockerfile" --build-arg MEDIA_VERSION="$release" -t "$image" "$root"
fi

library="$(mktemp -d)"
# Secrets the checks look for, as `grep -f` pattern files: never as an argument (docs/security.md).
secrets="$(mktemp -d)"
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
core_convex_url="${MEDIA_BASE_URL}/convex"
# The owner the packaged-stack suite sets the core up with, and the image's CLI signs in as.
owner_name=owner
owner_password=stack-test-password
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
  rm -rf "$secrets"
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
status_of() { curl -s -o /dev/null -w "%{http_code}" "${MEDIA_BASE_URL}$1"; }
check "/convex is the core's Convex backend" '[[ "$(curl -fsS "${core_convex_url}/instance_name")" == core ]]'
check "/movies/convex answers Not Found" \
  '[[ "$(status_of /movies/convex)" == 404 && "$(status_of /movies/convex/instance_name)" == 404 ]] &&
    ! curl -s "${MEDIA_BASE_URL}/movies/convex/version" | grep -qF "<html"'
convex_backends() {
  in_movies sh -c 'for p in /proc/[0-9]*; do
    tr "\0" " " <"$p/cmdline" 2>/dev/null | grep -q "^/app/convex/convex-local-backend " && echo "${p#/proc/}"
  done' | wc -l
}
check "the image runs one Convex backend" \
  '[[ "$(convex_backends)" -eq 1 ]] &&
    ! in_movies test -e /app/backend && ! in_movies test -e /etc/s6-overlay/s6-rc.d/convex-movies &&
    ! in_movies curl -fsS http://127.0.0.1:3220/version >/dev/null 2>&1'
check "/api is the media service" 'answers /api/health "\"backend\":\"connected\""'
check "/ is the account client" 'answers / "<title>[media]</title>"'
check "/movies is the movies client" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "${MEDIA_BASE_URL}/movies")" == "308 ${MEDIA_BASE_URL}/movies/" ]] &&
    answers /movies/ "<title>[movies]</title>" && answers /movies/title/x "/movies/assets/"'
check "/music is the music client, and its art is the media service's" \
  '[[ "$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "${MEDIA_BASE_URL}/music")" == "308 ${MEDIA_BASE_URL}/music/" ]] &&
    answers /music/ "<title>[music]</title>" && answers /music/albums/x "/music/assets/" &&
    [[ "$(status_of /music/art/0000)" != 200 ]] && ! curl -s "${MEDIA_BASE_URL}/music/art/0000" | grep -qF "<html"'
check "every web client reaches the core on this address" \
  'in_movies grep -rqF "${core_convex_url}" /run/media/account &&
    in_movies grep -rqF "${core_convex_url}" /run/media/web &&
    in_movies grep -rqF "${core_convex_url}" /run/media/music &&
    ! in_movies grep -rqF "${MEDIA_BASE_URL}/movies/convex" /run/media/web'
check "Convex HTTP actions stay inside the container" \
  '! curl -fsS "${MEDIA_BASE_URL}/convex/.well-known/jwks.json" 2>/dev/null | grep -qF "\"keys\"" &&
    in_movies curl -fsS http://127.0.0.1:3211/.well-known/jwks.json | grep -qF "\"keys\""'
check "the data root has one folder per domain" '[[ "$(in_movies ls /data | tr "\n" " ")" == "core movies " ]]'
check "the Convex backend runs unprivileged" '[[ "$(owners /app/convex/convex-local-backend)" == convex ]]'
check "Caddy runs unprivileged" '[[ "$(owners "caddy run")" == caddy ]]'
check "no instance secret or service key is on a command line" \
  '! in_movies sh -c "cat /proc/[0-9]*/cmdline 2>/dev/null | tr \"\\0\" \"\\n\" | grep -qxFf /data/core/secrets/instance_secret -f /data/core/secrets/media-service-key"'

check "the media service runs unprivileged" '[[ -n "$media_pid" && "$media_uid" == "$PUID" && "$media_uid" != 0 ]]'
check "the service environment is private" \
  '[[ "$(in_movies stat -c "%u %a" /run/movies/media.env)" == "$PUID 600" ]]'
check "backups are the media user's and private" \
  '[[ "$(in_movies stat -c "%u %a" /data/core/backups)" == "$PUID 700" ]]'
check "the media service's key is root's and private" \
  '[[ "$(in_movies stat -c "%U %a" /data/core/secrets/media-service-key /data/core/secrets/media-service-id | sort -u)" == "root 600" ]]'
check "the media service signs in to the core with its stored key and the core's ticket keys" \
  '[[ "$(in_movies sed -n s/^MEDIA_SERVICE_API_KEY=//p /run/movies/media.env)" == "$(in_movies cat /data/core/secrets/media-service-key)" ]] &&
    in_movies grep -qx "CONVEX_URL=http://127.0.0.1:3210" /run/movies/media.env &&
    in_movies grep -qx "CONVEX_PUBLIC_URL=${core_convex_url}" /run/movies/media.env &&
    in_movies grep -qx "CONVEX_BACKEND_DIR=/app/platform" /run/movies/media.env &&
    in_movies grep -q "^MEDIA_TICKET_KEYS=." /run/movies/media.env &&
    ! in_movies grep -q "^PLAYBACK_TOKEN_SECRET=" /run/movies/media.env'
# The service key and the ticket keys, by redirection only, one pattern per line in a private file.
secret_patterns() {
  (
    umask 077
    {
      in_movies cat /data/core/secrets/media-service-key
      printf '\n'
      in_movies sed -n 's/^MEDIA_TICKET_KEYS=//p' /run/movies/media.env
    } >"$secrets/patterns"
  )
  printf '%s\n' "$secrets/patterns"
}
check "the service key and ticket keys stay out of the log" \
  '! compose logs --no-color media 2>&1 | grep -qF -f "$(secret_patterns)"'
check "the library is read-only" '! in_movies setpriv --reuid=0 touch /media/library/written 2>/dev/null'
check "no secret is in the command line" \
  '! in_movies cat "/proc/${media_pid}/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
check "the admin key is not in the web app" \
  '! in_movies sh -c "grep -rqF \"\$(sed -n s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p /run/movies/media.env)\" /run/media /app/web /app/account"'
check "Convex refuses admin calls without the key" \
  '[[ "$(status_of /convex/api/check_admin_key)" =~ ^40[13]$ ]]'

in_movies sh -c "kill $media_pid"
for _ in $(seq 1 60); do
  restarted="$(media_pid)"
  [[ -n "$restarted" && "$restarted" != "$media_pid" ]] && healthy && break
  sleep 1
done
check "s6 restarts the media service when it dies" '[[ -n "$restarted" && "$restarted" != "$media_pid" ]] && healthy'

# The status of each of `$2` requests for the URL `$1`, one a line, sent by one curl over one
# connection, so a slow host refills no bucket between them; curl arguments, such as a header,
# follow. A separate curl for each request took long enough under load to refill a limit.
burst() {
  local url="$1" count="$2"
  shift 2
  curl -s -w '\nSTATUS %{http_code}\n' "$@" "${url}?n=[1-${count}]" | sed -n 's/^STATUS //p'
}

statuses="$(burst "${MEDIA_BASE_URL}/api/health" 80)"
check "a client past its limit through Caddy gets 429" 'grep -qx 429 <<<"$statuses"'
check "the container's health check is never limited" \
  '[[ "$(in_movies curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4300/api/health)" == 200 ]] &&
    [[ "$(docker inspect -f "{{.State.Health.Status}}" "$(compose ps -q media)")" == healthy ]]'
sleep 7
spoofed="$(burst "${MEDIA_BASE_URL}/api/health" 80 -H "X-Forwarded-For: 127.0.0.1")"
check "a client cannot pass as the install by sending X-Forwarded-For" 'grep -qx 429 <<<"$spoofed"'
sleep 7

MEDIA_PACKAGED_STACK=1 \
  MEDIA_PACKAGED_CONVEX_URL="$core_convex_url" \
  MEDIA_PACKAGED_SERVER_URL="$MEDIA_BASE_URL" \
  MEDIA_PACKAGED_LIBRARY=/media/library \
  MEDIA_PACKAGED_OWNER="$owner_name" \
  MEDIA_PACKAGED_PASSWORD="$owner_password" \
  MEDIA_PACKAGED_RESTART="docker compose ${compose_args[*]} restart media" \
  pnpm --dir "$root" exec vitest run --root "$root" apps/media/src/stack/packaged-stack.test.ts

# The first value at a path, such as `0.id`, of the JSON on stdin.
json_at() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const v = process.argv[1].split(".").reduce((o, k) => o?.[k], JSON.parse(s));
    if (v === undefined || v === null) process.exit(1);
    process.stdout.write(String(v)); })' "$1"
}
# Negotiates a stream for a ticket, as a player at most `$2` pixels tall; prints the stream URL.
negotiate() {
  node -e 'const [url, ticket, height] = process.argv.slice(1);
    const capabilities = { containers: ["mp4"], videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
      audioCodecs: [{ codec: "aac" }], maxWidth: Math.round((Number(height) * 16) / 9),
      maxHeight: Number(height), hls: false, mse: true };
    fetch(`${url}/api/playback/negotiate`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ticket, capabilities, startSeconds: 0 }) })
      .then(async (r) => { const b = await r.json(); if (r.status !== 200) throw new Error(JSON.stringify(b)); process.stdout.write(b.url); })
      .catch((e) => { console.error(String(e)); process.exit(1); });' "$MEDIA_BASE_URL" "$1" "$2"
}
# A new stream ticket for the title the image's CLI finds by `$1`.
cli_ticket() {
  local title
  title="$(in_movies media movies titles search --query "$1" | json_at 0.id)" &&
    in_movies media movies play start --title-id "$title" | json_at ticket
}

# The sign-in boundary (ADR 0007). Sign-ins straight to the core are refused, and one client gets
# 10 sign-ins at once through the boundary. An unknown username keeps the owner's own limit whole.
straight_sign_in="$(curl -s -X POST -H "content-type: application/json" \
  -d "{\"path\":\"auth:signIn\",\"args\":{\"provider\":\"password\",\"params\":{\"username\":\"$owner_name\",\"password\":\"$owner_password\"}},\"format\":\"json\"}" \
  "${core_convex_url}/api/action")"
check "a sign-in sent straight to auth:signIn over /convex is refused" \
  'grep -qF "\"code\":\"forbidden\"" <<<"$straight_sign_in" && ! grep -qF "refreshToken" <<<"$straight_sign_in"'
# The packaged suite above signed in from this host, so wait until the host's budget is whole:
# 10 tries, one every 5 seconds.
sleep 50
sign_ins="$(burst "${MEDIA_BASE_URL}/api/auth/sign-in" 11 -X POST -H "content-type: application/json" \
  -d '{"provider":"password","params":{"username":"nobody-e2e","password":"wrong-password"}}')"
check "the eleventh fast sign-in from one client gets a rate limit" \
  '[[ "$(head -n 10 <<<"$sign_ins" | sort -u)" == 401 && "$(tail -n 1 <<<"$sign_ins")" == 429 ]]'
check "the boundary logs its sign-ins without a password" \
  'compose logs --no-color media 2>&1 | grep -F "SignInBoundary.relayed" >/dev/null &&
    ! compose logs --no-color media 2>&1 | grep -qF -e "$owner_password" -e wrong-password'

# A published `main` image is labelled `main` instead, so the label is checked only when this
# script built the image (and in the Image workflow, which builds it with the version).
if [[ -z "${IMAGE:-}" ]]; then
  label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")"
  check "the image's version label is the release version" '[[ "$label" == "$release" ]]'
fi
check "the image's CLI reports the release version" '[[ "$(in_movies media --version)" == "$release" ]]'
check "the image's CLI signs in to the core" \
  'printf %s "$owner_password" | in_movies media auth login --username "$owner_name" >/dev/null'
check "the image's CLI calls the core as the owner" \
  '[[ "$(in_movies media auth sessions current | json_at username)" == "$owner_name" ]]'
ticket="$(cli_ticket "Big Buck Fixture")" ||
  { echo "check failed: the image's CLI starts a play on the core" >&2; exit 1; }
play_url="$(negotiate "$ticket" 1080)" ||
  { echo "check failed: the media service admits the CLI's ticket" >&2; exit 1; }
echo "ok: the image's CLI starts a play the media service admits: ${play_url%%\?*}"
check "the stream URL is at the public URL" '[[ "$play_url" == "$MEDIA_BASE_URL/"* ]]'
check "the stream URL plays from the host" \
  '[[ "$(curl -fsS -r 0-0 -o /dev/null -w "%{http_code}" "$play_url")" =~ ^20[06]$ ]]'
check "the CLI login is root's and private, in the data volume" \
  '[[ -n "$(in_movies find /data/movies/config/media/sessions -type f)" &&
    -z "$(in_movies find /data/movies/config/media/sessions -type f \( ! -user root -o ! -perm 600 \))" ]]'
check "the retained log records the streams" \
  'in_movies grep -rqF "\"message\":\"Stream.started\"" /data/movies/media/logs'
check "the retained log is private to the media user" \
  '[[ "$(in_movies stat -c "%u %a" /data/movies/media/logs)" == "$PUID 700" ]] &&
    ! in_movies find /data/movies/media/logs -type f ! -perm 600 | grep -q .'

running_ffmpeg() {
  in_movies sh -c 'for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = ffmpeg ] && [ "$(cut -d" " -f3 "$p/stat" 2>/dev/null)" != Z ] &&
      echo "${p#/proc/}"
  done' || true
}
long_ticket="$(cli_ticket "Long Fixture")" && long_url="$(negotiate "$long_ticket" 144)" &&
  curl -fsS -o /dev/null "$long_url" ||
  { echo "check failed: the media service transcodes the long fixture" >&2; exit 1; }
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

archives() { in_movies sh -c "ls /data/core/backups | grep -c '^core-manual-.*\.zip$'" || true; }
service_key="$(in_movies cat /data/core/secrets/media-service-key)"
before="$(archives)"
in_movies sh -c 'echo 0.0.0-previous > /data/core/version'
compose restart media >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "an upgrade of the core backs it up first" '[[ "$(archives)" -gt "$before" ]]'
check "the upgrade backup is the media user's" \
  '[[ -z "$(in_movies find /data/core/backups -name "core-manual-*.zip" ! -uid "$PUID")" ]]'
check "the restarted service keeps its secrets" 'healthy'
check "a restart reuses the media service's key" \
  '[[ "$(in_movies cat /data/core/secrets/media-service-key)" == "$service_key" ]]'

check "a deployed upgrade clears its backup marker" '! in_movies test -e /data/core/upgrade-backup'

after="$(archives)"
in_movies sh -c 'cp /data/core/version /data/core/upgrade-backup && echo 0.0.0-previous > /data/core/version'
compose restart media >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "the service is healthy after the retried upgrade" 'healthy'
check "a retried upgrade does not back up again" '[[ "$(archives)" -eq "$after" ]]'

service_id="$(in_movies cat /data/core/secrets/media-service-id)"
in_movies rm /data/core/secrets/media-service-key
compose restart media >/dev/null
for _ in $(seq 1 60); do
  healthy && break
  sleep 2
done
check "a lost service key is issued again to the same principal" \
  'healthy && [[ "$(in_movies cat /data/core/secrets/media-service-id)" == "$service_id" &&
    "$(in_movies cat /data/core/secrets/media-service-key)" != "$service_key" ]]'

# An outer proxy on the container's loopback, as a TLS proxy beside the NixOS module connects:
# 80 requests for one client, then one for another, all from one curl over one connection, so no
# refill falls between them. A curl for each request let a slow host refill the bucket past the
# burst, and the last request land after a refill, which made the untrusted check flake.
through_outer_proxy() {
  in_movies curl -s -w '\nSTATUS %{http_code}\n' -H "X-Forwarded-For: 203.0.113.1" \
    'http://127.0.0.1:8080/api/health?n=[1-80]' --next \
    -s -w '\nSTATUS %{http_code}\n' -H "X-Forwarded-For: 203.0.113.2" \
    http://127.0.0.1:8080/api/health | sed -n 's/^STATUS //p'
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
