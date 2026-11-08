#!/bin/sh
# `docker compose exec media media ...`: the CLI against this container's own services, with its
# logins in the data volume.
export MEDIA_CONVEX_URL="${MEDIA_CONVEX_URL:-http://127.0.0.1:3220}"
export MEDIA_SERVER_URL="${MEDIA_SERVER_URL:-http://127.0.0.1:8080}"
export MEDIA_CORE_URL="${MEDIA_CORE_URL:-http://127.0.0.1:3210}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/movies/config}"
case " $* " in *" admin reset-password "*) reset=1 ;; *) reset=0 ;; esac
if [ "$reset" = 1 ] && [ -z "${MEDIA_CORE_ADMIN_KEY:-}" ] && [ -r /data/core/secrets/instance_secret ]; then
  MEDIA_CORE_ADMIN_KEY="$(LD_PRELOAD=/app/convex/argv-secret.so \
    ARGV_SECRET_FILE=/data/core/secrets/instance_secret \
    /app/convex/generate_key core @ARGV_SECRET_FILE 2>/dev/null | tail -n 1)"
  export MEDIA_CORE_ADMIN_KEY
fi
exec node /app/cli/media.mjs "$@"
