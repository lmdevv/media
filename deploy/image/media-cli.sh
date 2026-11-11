#!/bin/sh
# `docker compose exec media media ...`: the CLI against this container's own services, with its
# logins in the data volume.
export MEDIA_CORE_URL="${MEDIA_CORE_URL:-http://127.0.0.1:3210}"
export MEDIA_SERVER_URL="${MEDIA_SERVER_URL:-http://127.0.0.1:8080}"
# Sign-ins go through the server's boundary behind Caddy, as every client's do (ADR 0007).
export MEDIA_CORE_SIGN_IN_URL="${MEDIA_CORE_SIGN_IN_URL:-http://127.0.0.1:8080/api/auth/sign-in}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/movies/config}"
case " $* " in *" admin reset-password "*) reset=1 ;; *) reset=0 ;; esac
if [ "$reset" = 1 ] && [ -z "${MEDIA_CORE_ADMIN_KEY:-}" ] && [ -r /data/core/secrets/instance_secret ]; then
  MEDIA_CORE_ADMIN_KEY="$(LD_PRELOAD=/app/convex/argv-secret.so \
    ARGV_SECRET_FILE=/data/core/secrets/instance_secret \
    /app/convex/generate_key core @ARGV_SECRET_FILE 2>/dev/null | tail -n 1)"
  export MEDIA_CORE_ADMIN_KEY
fi
exec node /app/cli/media.mjs "$@"
