#!/bin/sh
# The image's `media` CLI: `docker compose exec media media login`. It talks to this container's
# own old movies Convex backend, media service, and core at their addresses inside the container,
# whatever the host publishes; the stream URLs `media play` prints still use MEDIA_BASE_URL. It
# keeps its logins in the data volume so they last across upgrades. Set any of these variables on
# the exec to override them.
export MEDIA_CONVEX_URL="${MEDIA_CONVEX_URL:-http://127.0.0.1:3220}"
export MEDIA_SERVER_URL="${MEDIA_SERVER_URL:-http://127.0.0.1:8080}"
export MEDIA_CORE_URL="${MEDIA_CORE_URL:-http://127.0.0.1:3210}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/movies/config}"
# `media admin reset-password` runs on the server host with the core's admin key, which root
# derives here from the core's instance secret (docs/operations.md).
if [ "$1 $2" = "admin reset-password" ] && [ -z "${MEDIA_CORE_ADMIN_KEY:-}" ] &&
  [ -r /data/core/secrets/instance_secret ]; then
  MEDIA_CORE_ADMIN_KEY="$(LD_PRELOAD=/app/convex/argv-secret.so \
    ARGV_SECRET_FILE=/data/core/secrets/instance_secret \
    /app/convex/generate_key core @ARGV_SECRET_FILE 2>/dev/null | tail -n 1)"
  export MEDIA_CORE_ADMIN_KEY
fi
exec node /app/cli/media.mjs "$@"
