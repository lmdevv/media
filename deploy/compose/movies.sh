#!/bin/sh
# The image's `media` CLI: `docker compose exec movies media login`. It talks to this stack's own
# Convex and media service at their addresses inside the container, whatever the host publishes
# them on; the stream URLs `media play` prints still use MEDIA_BASE_URL. It keeps its login in
# the data volume so it lasts across upgrades. Set any of these variables on the exec to override
# them.
export MEDIA_CONVEX_URL="${MEDIA_CONVEX_URL:-$CONVEX_URL}"
export MEDIA_SERVER_URL="${MEDIA_SERVER_URL:-http://127.0.0.1:8080}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/config}"
exec node /app/cli/media.mjs "$@"
