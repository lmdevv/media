# The entrypoint of the NixOS module's Convex container, run by the image's bash. The upstream
# entrypoint and `generate_admin_key.sh` pass the instance secret as an argument, which any local
# process can read in /proc/<pid>/cmdline. This one keeps the secret in its file, creates it there
# on first start, and starts the backend through the argv-secret shim (deploy/image/argv-secret.c),
# so every command line shows only the placeholder (docs/security.md).
set -euo pipefail
umask 077
data=/convex/data
secret="$data/credentials/instance_secret"
mkdir -p "$data/tmp" "$data/storage" "$data/credentials"
if [ ! -s "$secret" ]; then
  head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' >"$secret.new"
  mv "$secret.new" "$secret"
fi
printf '%s\n' "$INSTANCE_NAME" >"$data/credentials/instance_name"
export TMPDIR="$data/tmp" LD_PRELOAD=/argv-secret.so ARGV_SECRET_FILE="$secret"
cd /convex
exec ./convex-local-backend \
  --instance-name "$INSTANCE_NAME" \
  --instance-secret @ARGV_SECRET_FILE \
  --port 3210 \
  --site-proxy-port 3211 \
  --convex-origin "$CONVEX_CLOUD_ORIGIN" \
  --convex-site "$CONVEX_SITE_ORIGIN" \
  --beacon-tag self-hosted-docker \
  --disable-beacon \
  --redact-logs-to-client \
  --do-not-require-ssl \
  --local-storage "$data/storage" \
  "$data/db.sqlite3"
