#!/usr/bin/env bash
#   scripts/nixos-module-e2e.sh                              # software transcoding
#   HARDWARE_ACCELERATION=auto scripts/nixos-module-e2e.sh   # probe and use the host's Quick Sync
#
# Needs sudo, Docker, and Nix with flakes. Env: MEDIA_PORT (18380), HARDWARE_ACCELERATION (none),
# KEEP=1 to leave it running. Behind it: the core's Convex on 18310 and the media service on 18330.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
media_port="${MEDIA_PORT:-18380}"
acceleration="${HARDWARE_ACCELERATION:-none}"
unit=media-server-module-e2e
proxy_unit=media-proxy-module-e2e
containers=(media-core-convex)
# Not under /tmp or /var/tmp: the service has its own (PrivateTmp).
base=/var/lib/media-module-e2e
# The owner the packaged-stack suite sets the core up with.
owner_name=owner
owner_password=stack-test-password

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    sudo journalctl -u "$unit" --no-pager -n 80 >&2 || true
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    sudo systemctl stop "$unit" "$proxy_unit" >/dev/null 2>&1 || true
    sudo rm -f "/run/systemd/system/$unit.service" "/run/systemd/system/$proxy_unit.service"
    sudo systemctl daemon-reload
    docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
    # The setup writes these two web clients outside the unit's runtime folder.
    sudo rm -rf "$base" /run/media-account /run/media-music
  fi
  exit $status
}

for container in "${containers[@]}"; do
  if docker inspect "$container" >/dev/null 2>&1; then
    echo "a container named $container already exists; remove it first" >&2
    exit 1
  fi
done
# /run/media-account is every release's since 0.3.0; /run/media-server is the service's since 0.4.1.
if [[ -e /run/media-server || -e /run/media-account ]]; then
  echo "/run/media-server or /run/media-account exists, so a real install runs here; run this on another host" >&2
  exit 1
fi
# Only past the checks above: from here, every container and folder the cleanup removes is this
# run's own.
trap cleanup EXIT

sudo rm -rf "$base"
sudo install -d -m 755 "$base" "$base/library"
sudo chown "$(id -u):$(id -g)" "$base/library"
node "$root/apps/media/scripts/generate-fixtures.ts" "$base/library" >/dev/null
chmod -R a+rX "$base/library"

evaluated="$(
  nix eval --json --impure --expr "
    let
      flake = builtins.getFlake \"git+file://$root\";
      system = flake.inputs.nixpkgs.lib.nixosSystem {
        system = builtins.currentSystem;
        modules = [
          flake.nixosModules.default
          {
            boot.isContainer = true;
            system.stateVersion = \"26.05\";
            virtualisation.oci-containers.backend = \"docker\";
            services.media = {
              enable = true;
              user = \"nobody\";
              group = \"nogroup\";
              dataDir = \"$base/data\";
              transcodeDir = \"$base/transcode\";
              port = $media_port;
              internalPorts = { coreConvex = 18310; media = 18330; };
              libraryDirs = [ \"$base/library\" ];
              publicUrl = \"http://127.0.0.1:$media_port\";
              hardwareAcceleration = \"$acceleration\";
            };
          }
        ];
      };
      inherit (system) config;
    in {
      unitDrv = config.systemd.units.\"media-server.service\".unit.drvPath;
      proxyDrv = config.systemd.units.\"media-proxy.service\".unit.drvPath;
      tmpfiles = config.systemd.tmpfiles.rules;
      containers = builtins.mapAttrs (_: c: { inherit (c) image ports volumes environment entrypoint cmd; })
        config.virtualisation.oci-containers.containers;
    }"
)"
field() { node -e "process.stdout.write([].concat(JSON.parse(process.argv[1])[process.argv[2]]).join('\n'))" "$evaluated" "$1"; }

unit_file="$(nix build --no-link --print-out-paths "$(field unitDrv)^out")/media-server.service"
proxy_file="$(nix build --no-link --print-out-paths "$(field proxyDrv)^out")/media-proxy.service"
# Only the module's own folders, all under $base. The evaluated system's other rules (such as its
# /lib64 loader link, a stub where the host may run nix-ld) must never reach the host.
module_tmpfiles="$(field tmpfiles | awk -v base="$base" '$2 == base || index($2, base "/") == 1')"
[[ -n "$module_tmpfiles" ]] || { echo "the module declared no folders under $base" >&2; exit 1; }
printf '%s\n' "$module_tmpfiles" | sudo systemd-tmpfiles --create -

container_field() {
  node -e 'const c = JSON.parse(process.argv[1]).containers[process.argv[2]]; const v = c[process.argv[3]];
    process.stdout.write(Array.isArray(v) ? v.join("\n") : typeof v === "object" ?
      Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n") : v)' "$evaluated" "$1" "$2"
}
# container_field joins a list with newlines and no newline after the last item, which `read`
# returns only through its `|| [[ -n ... ]]`.
for container in "${containers[@]}"; do
  env_args=() volume_args=() cmd_args=()
  while IFS= read -r pair || [[ -n "$pair" ]]; do env_args+=(-e "$pair"); done < <(container_field "$container" environment)
  while IFS= read -r volume || [[ -n "$volume" ]]; do volume_args+=(-v "$volume"); done < <(container_field "$container" volumes)
  while IFS= read -r arg || [[ -n "$arg" ]]; do cmd_args+=("$arg"); done < <(container_field "$container" cmd)
  docker run -d --name "$container" -p "$(container_field "$container" ports)" "${volume_args[@]}" \
    --entrypoint "$(container_field "$container" entrypoint)" "${env_args[@]}" \
    "$(container_field "$container" image)" "${cmd_args[@]}" >/dev/null
done

sed '/^\(Requires\|After\)=.*docker-media-core-convex.service/d' "$unit_file" |
  sudo tee "/run/systemd/system/$unit.service" >/dev/null
sudo cp "$proxy_file" "/run/systemd/system/$proxy_unit.service"
sudo systemctl daemon-reload
sudo systemctl start "$proxy_unit" "$unit"

media_url="http://127.0.0.1:$media_port"
healthy() { curl -fsS "$media_url/api/health" 2>/dev/null | grep -q '"backend":"connected"'; }
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

answers() { curl -fsS "$media_url$1" 2>/dev/null | grep -qF "$2"; }
status_of() { curl -s -o /dev/null -w "%{http_code}" "$media_url$1"; }
check "/convex is the core's Convex backend" '[[ "$(curl -fsS "$media_url/convex/instance_name")" == core ]]'
check "/movies/convex answers Not Found" \
  '[[ "$(status_of /movies/convex)" == 404 && "$(status_of /movies/convex/instance_name)" == 404 ]]'
check "/ is the account client" 'answers / "<title>[media]</title>"'
check "/movies is the movies client" 'answers /movies/ "<title>[movies]</title>"'
check "Convex HTTP actions stay inside the containers" \
  '! curl -fsS "$media_url/convex/.well-known/jwks.json" 2>/dev/null | grep -qF "\"keys\""'

pid="$(systemctl show -p MainPID --value "$unit")"
check "the media service runs as its own user" '[[ "$(sudo stat -c %U "/proc/$pid")" == nobody ]]'
check "the service environment is private" \
  '[[ "$(sudo stat -c "%U %a" /run/media-server/media.env)" == "nobody 600" ]]'
check "backups are the service user's and private" \
  '[[ "$(sudo stat -c "%U %a" "$base/data/core/backups")" == "nobody 700" ]]'
check "the media service's key is root's and private" \
  '[[ "$(sudo stat -c "%U %a" "$base/data/core/secrets/media-service-key" "$base/data/core/secrets/media-service-id" | sort -u)" == "root 600" ]]'
check "the media service signs in to the core with its stored key and the core's ticket keys" \
  '[[ "$(sudo sed -n "s/^MEDIA_SERVICE_API_KEY=//p" /run/media-server/media.env)" == "$(sudo cat "$base/data/core/secrets/media-service-key")" ]] &&
    sudo grep -q "^MEDIA_TICKET_KEYS=." /run/media-server/media.env &&
    ! sudo grep -q "^PLAYBACK_TOKEN_SECRET=" /run/media-server/media.env'
check "the library is mounted read-only for the service, even for root" \
  '! sudo nsenter -t "$pid" -m touch "$base/library/written" 2>/dev/null'
check "the rest of the system is read-only for the service" \
  '! sudo nsenter -t "$pid" -m touch "$base/outside" 2>/dev/null'
check "no secret is in the command line" '! sudo cat "/proc/$pid/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
setup_script="$(sed -n 's/^ExecStartPre=+//p' "$unit_file")"
# The admin key and the service key as `grep -f` patterns, by redirection only: a check for a
# secret never puts it in an argument (docs/security.md).
secrets="$(mktemp -d)"
(
  umask 077
  sudo sed -n -e 's/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p' -e 's/^MEDIA_SERVICE_API_KEY=//p' \
    /run/media-server/media.env >"$secrets/patterns"
)
check "no secret is in the unit or its startup script" \
  '[[ -s "$secrets/patterns" ]] && ! sudo grep -qF -f "$secrets/patterns" "$unit_file" "$setup_script"'
rm -rf "$secrets"
sudo systemd-analyze security "$unit" --no-pager | tail -1

MEDIA_PACKAGED_STACK=1 \
  MEDIA_PACKAGED_CONVEX_URL="$media_url/convex" \
  MEDIA_PACKAGED_SERVER_URL="$media_url" \
  MEDIA_PACKAGED_LIBRARY="$base/library" \
  MEDIA_PACKAGED_OWNER="$owner_name" \
  MEDIA_PACKAGED_PASSWORD="$owner_password" \
  MEDIA_PACKAGED_RESTART="sudo systemctl restart $unit" \
  pnpm --dir "$root" exec vitest run --root "$root" apps/media/src/stack/packaged-stack.test.ts

if [[ "$acceleration" != none ]]; then
  logs="$(sudo journalctl -u "$unit" --no-pager)"
  check "the sandboxed service found Quick Sync" 'grep -q "\"qsv\":true" <<<"$logs"'
  check "no transcode fell back from Quick Sync" '! grep -q "qsv_disabled\|encoder_failed" <<<"$logs"'
fi
