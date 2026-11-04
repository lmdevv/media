#!/usr/bin/env bash
set -euo pipefail
umask 077

log() { echo "[movies] $*" >&2; }

data=/data
public_url="${MEDIA_BASE_URL%/}"
convex_public_url="${CONVEX_PUBLIC_URL%/}"
convex_url="${CONVEX_URL%/}"
credentials="${CONVEX_CREDENTIALS_DIR:-/run/convex-credentials}"
version="$(node -p 'require("/app/backend/package.json").version')"
if [ -s /app/backend/.functions-hash ]; then
  version="$version+$(cat /app/backend/.functions-hash)"
fi
puid="${PUID:-1000}"
pgid="${PGID:-1000}"

if ! [[ "$puid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ ]] || [ "$puid" = 0 ] || [ "$pgid" = 0 ]; then
  log "PUID and PGID must be numeric and not 0 (root); got PUID=$puid PGID=$pgid"
  exit 1
fi

# At most seven significant digits, so the arithmetic below never wraps a huge number into range.
if [ -n "${LOG_MAX_MB:-}" ] &&
  ! [[ "$LOG_MAX_MB" =~ ^0*[0-9]{1,7}$ && "$((10#$LOG_MAX_MB))" -ge 8 && "$((10#$LOG_MAX_MB))" -le 1048576 ]]; then
  log "LOG_MAX_MB must be a whole number of MiB from 8 to 1048576; got LOG_MAX_MB=$LOG_MAX_MB"
  exit 1
fi

[ "$(id -g movies)" = "$pgid" ] || groupmod --non-unique --gid "$pgid" movies
[ "$(id -u movies)" = "$puid" ] || usermod --non-unique --uid "$puid" --gid "$pgid" movies

for node in /dev/dri/renderD*; do
  [ -e "$node" ] || continue
  gid="$(stat -c %g "$node")"
  getent group "$gid" >/dev/null || groupadd --gid "$gid" "render$gid"
  usermod -a -G "$(getent group "$gid" | cut -d: -f1)" movies
done

install -d -m 700 -o movies -g movies "$data/media" "$data/backups" /transcode
find "$data/media" "$data/backups" /transcode \( \! -user movies -o \! -group movies \) \
  -exec chown -h movies:movies {} +

convex_up() {
  CONVEX_VERSION_URL="$convex_url/version" node -e \
    "fetch(process.env.CONVEX_VERSION_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

# Compared by digest: the same backend may be pulled from a renamed repository (ghcr.io/get-convex
# became ghcr.io/convex).
built_for="$(cat /app/convex/image 2>/dev/null || true)"
if [ -n "${CONVEX_BACKEND_IMAGE:-}" ] && [ -n "$built_for" ] &&
  [ "${CONVEX_BACKEND_IMAGE##*@}" != "${built_for##*@}" ]; then
  log "warning: this image was built for the Convex backend $built_for, but compose.yaml runs"
  log "$CONVEX_BACKEND_IMAGE; use the compose.yaml of the release the image comes from"
fi

log "waiting for Convex at $convex_url"
for _ in $(seq 1 120); do
  convex_up && break
  sleep 1
done
convex_up || { log "Convex did not answer at $convex_url"; exit 1; }

instance_name="${CONVEX_INSTANCE_NAME:-$(cat "$credentials/instance_name" 2>/dev/null || echo convex-self-hosted)}"
instance_secret="${CONVEX_INSTANCE_SECRET:-$(cat "$credentials/instance_secret" 2>/dev/null || true)}"
if [ -z "$instance_secret" ]; then
  log "no Convex instance secret: mount the backend's credentials at $credentials or set CONVEX_INSTANCE_SECRET"
  exit 1
fi
admin_key="$(/app/convex/generate_key "$instance_name" "$instance_secret" | tail -n 1)"
unset instance_secret CONVEX_INSTANCE_SECRET

export CONVEX_SELF_HOSTED_URL="$convex_url"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$admin_key"
cd /app/backend
convex() { node node_modules/convex/bin/main.js "$@"; }

if [ -s "$data/version" ] && [ "$(cat "$data/version")" != "$version" ] &&
  [ "$(cat "$data/upgrade-backup" 2>/dev/null)" != "$version" ]; then
  stamp="$(date -u +%Y-%m-%dT%H-%M-%S-000Z)"
  backup="$data/backups/movies-manual-$stamp.zip"
  log "upgrading from $(cat "$data/version") to $version; backing up to $backup first"
  convex export --include-file-storage --path "$data/backups/.partial-movies-manual-$stamp.zip"
  mv "$data/backups/.partial-movies-manual-$stamp.zip" "$backup"
  chown movies:movies "$backup"
  printf '%s\n' "$version" >"$data/upgrade-backup"
fi

log "deploying the Convex functions ($version)"
convex deploy --yes --codegen disable --typecheck disable

log "configuring the deployment"
media_env="$(node scripts/configure.ts "--site-url=$public_url" "--media-url=$public_url")"
media_service_api_key="$(sed -n 's/^MEDIA_SERVICE_API_KEY=//p' <<<"$media_env")"
playback_token_secret="$(sed -n 's/^PLAYBACK_TOKEN_SECRET=//p' <<<"$media_env")"
unset media_env

umask 022
install -d -m 755 /run/movies
node /app/media/scripts/configure-web.ts --from /app/web --to /run/movies/web \
  --convex-url "$convex_public_url"

printf '%s\n' "$version" >"$data/version"
rm -f "$data/upgrade-backup"

env_file=/run/movies/media.env
install -m 600 -o movies -g movies /dev/null "$env_file"
setting() { [ -z "$2" ] || printf '%s=%s\n' "$1" "$2" >>"$env_file"; }
setting PORT 8080
setting MEDIA_BASE_URL "$public_url"
setting CONVEX_URL "$convex_url"
setting CONVEX_PUBLIC_URL "$convex_public_url"
setting MEDIA_SERVICE_API_KEY "$media_service_api_key"
setting PLAYBACK_TOKEN_SECRET "$playback_token_secret"
setting CONVEX_SELF_HOSTED_ADMIN_KEY "$admin_key"
setting CONVEX_BACKEND_DIR /app/backend
setting DATA_DIR "$data/media"
setting BACKUP_DIR "$data/backups"
setting TRANSCODE_DIR /transcode
setting WEB_DIST_DIR /run/movies/web
setting LIBRARY_ROOTS "${LIBRARY_ROOTS:-/media}"
optional_settings=(
  BACKUP_RETENTION_DAYS
  TMDB_API_KEY
  OMDB_API_KEY
  OTEL_EXPORTER_OTLP_ENDPOINT
  HARDWARE_ACCELERATION
  QSV_DEVICE
  VAAPI_DEVICE
  LIBVA_DRIVER_NAME
  MAX_CONCURRENT_TRANSCODES
  MAX_CONCURRENT_REMUXES
  STREAM_IDLE_SECONDS
  STREAM_BUFFER_AHEAD_SECONDS
  MIN_FREE_TRANSCODE_MB
  LIBRARY_RECONCILE_MINUTES
  TRICKPLAY
  TRICKPLAY_INTERVAL_SECONDS
  TRICKPLAY_CONCURRENCY
  LIBRARY_WATCH
  LIBRARY_POLL_SECONDS
  PROBE_TIMEOUT_SECONDS
  FILE_SCAN_TIMEOUT_SECONDS
  CACHE_MAX_MB
  LOG_LEVEL
  LOG_RETENTION_DAYS
  LOG_MAX_MB
)
for name in "${optional_settings[@]}"; do
  setting "$name" "${!name:-}"
done
unset admin_key media_service_api_key playback_token_secret CONVEX_SELF_HOSTED_ADMIN_KEY TMDB_API_KEY \
  OMDB_API_KEY

log "starting the media service at $public_url"
cd /app/media
exec setpriv --reuid=movies --regid=movies --init-groups --inh-caps=-all \
  env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production TZ="${TZ:-UTC}" \
  node --env-file="$env_file" --enable-source-maps dist/main.js
