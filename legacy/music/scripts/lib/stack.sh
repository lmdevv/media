# Helpers for scripts that drive a running [music] container, sourced by stack-e2e.sh and
# upgrade-e2e.sh. Each acts on the container named by the caller's `name` variable and runs the
# container's own Convex CLI with its admin key, as /app/bin/init does.

# Runs `convex <args>` inside the container against its backend.
convex_cli() {
  docker exec "$name" sh -c 'cd /app/backend && CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
    CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /data/secrets/admin_key)" \
    ./node_modules/.bin/convex "$@"' convex "$@"
}

# Prints every row of table $1 as JSON lines.
convex_data() { convex_cli data "$1" --limit 10000 --format jsonLines; }

# Prints the number of rows in table $1.
convex_rows() { convex_data "$1" | grep -c '"_id"' || true; }
