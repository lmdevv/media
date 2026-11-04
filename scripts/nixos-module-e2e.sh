#!/usr/bin/env bash
# NixOS module smoke test on a NixOS host, without a VM: evaluates nix/module.nix with the Docker
# backend, runs the Convex container the way the module's oci-containers unit does, installs the
# module's own generated movies.service (hardening included) as a runtime unit under
# /run/systemd/system, and runs apps/media/src/stack/packaged-stack.test.ts against it (sign-up,
# library, scan, direct and HLS playback, a service restart, CLI backup and restore). Then it
# checks the unit's sandbox and removes everything.
#
#   scripts/nixos-module-e2e.sh                              # software transcoding
#   HARDWARE_ACCELERATION=auto scripts/nixos-module-e2e.sh   # probe and use the host's Quick Sync
#
# Needs sudo, Docker, and Nix with flakes. Env: MEDIA_PORT (18380), CONVEX_PORT (18310),
# HARDWARE_ACCELERATION (none), KEEP=1 to leave it running.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
movies_port="${MEDIA_PORT:-18380}"
convex_port="${CONVEX_PORT:-18310}"
acceleration="${HARDWARE_ACCELERATION:-none}"
unit=movies-module-e2e
container=movies-convex
# Not under /tmp or /var/tmp: the service has its own (PrivateTmp).
base=/var/lib/movies-module-e2e

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    sudo journalctl -u "$unit" --no-pager -n 80 >&2 || true
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    sudo systemctl stop "$unit" >/dev/null 2>&1 || true
    sudo rm -f "/run/systemd/system/$unit.service"
    sudo systemctl daemon-reload
    docker rm -f "$container" >/dev/null 2>&1 || true
    sudo rm -rf "$base"
  fi
  exit $status
}
trap cleanup EXIT

if docker inspect "$container" >/dev/null 2>&1; then
  echo "a container named $container already exists; remove it first" >&2
  exit 1
fi

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
              backupDir = \"$base/data/backups\";
              transcodeDir = \"$base/transcode\";
              port = $movies_port;
              convexPort = $convex_port;
              libraryDirs = [ \"$base/library\" ];
              publicUrl = \"http://127.0.0.1:$movies_port\";
              convexPublicUrl = \"http://127.0.0.1:$convex_port\";
              hardwareAcceleration = \"$acceleration\";
            };
          }
        ];
      };
      inherit (system) config;
      container = config.virtualisation.oci-containers.containers.movies-convex;
    in {
      unitDrv = config.systemd.units.\"movies.service\".unit.drvPath;
      tmpfiles = config.systemd.tmpfiles.rules;
      inherit (container) image ports volumes environment;
    }"
)"
field() { node -e "process.stdout.write([].concat(JSON.parse(process.argv[1])[process.argv[2]]).join('\n'))" "$evaluated" "$1"; }

unit_file="$(nix build --no-link --print-out-paths "$(field unitDrv)^out")/movies.service"
# Only the module's own folders, all under $base. The evaluated system's other rules (such as its
# /lib64 loader link, a stub where the host may run nix-ld) must never reach the host.
module_tmpfiles="$(field tmpfiles | awk -v base="$base" '$2 == base || index($2, base "/") == 1')"
[[ -n "$module_tmpfiles" ]] || { echo "the module declared no folders under $base" >&2; exit 1; }
printf '%s\n' "$module_tmpfiles" | sudo systemd-tmpfiles --create -

env_args=()
while IFS= read -r pair; do env_args+=(-e "$pair"); done < <(
  node -e 'for (const [k, v] of Object.entries(JSON.parse(process.argv[1]).environment)) console.log(`${k}=${v}`)' "$evaluated"
)
docker run -d --name "$container" -p "$(field ports)" -v "$(field volumes)" "${env_args[@]}" \
  "$(field image)" >/dev/null

sed '/^\(Requires\|After\)=.*docker-movies-convex.service/d' "$unit_file" |
  sudo tee "/run/systemd/system/$unit.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl start "$unit"

media_url="http://127.0.0.1:$movies_port"
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

pid="$(systemctl show -p MainPID --value "$unit")"
check "the media service runs as its own user" '[[ "$(sudo stat -c %U "/proc/$pid")" == nobody ]]'
check "the service environment is private" \
  '[[ "$(sudo stat -c "%U %a" /run/movies/media.env)" == "nobody 600" ]]'
check "backups are private" '[[ "$(sudo stat -c "%a" "$base/data/backups")" == 700 ]]'
check "the library is mounted read-only for the service, even for root" \
  '! sudo nsenter -t "$pid" -m touch "$base/library/written" 2>/dev/null'
check "the rest of the system is read-only for the service" \
  '! sudo nsenter -t "$pid" -m touch "$base/outside" 2>/dev/null'
check "no secret is in the command line" '! sudo cat "/proc/$pid/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"'
setup_script="$(sed -n 's/^ExecStartPre=+//p' "$unit_file")"
check "no secret is in the unit or its startup script" \
  '! sudo grep -qF -e "$(sudo sed -n "s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p" /run/movies/media.env)" \
    -e "$(sudo sed -n "s/^MEDIA_SERVICE_API_KEY=//p" /run/movies/media.env)" "$unit_file" "$setup_script"'
sudo systemd-analyze security "$unit" --no-pager | tail -1

pnpm --dir "$root" --filter @lmdevv/movies build >/dev/null

MEDIA_PACKAGED_STACK=1 \
  MEDIA_PACKAGED_CONVEX_URL="http://127.0.0.1:$convex_port" \
  MEDIA_PACKAGED_SERVER_URL="$media_url" \
  MEDIA_PACKAGED_LIBRARY="$base/library" \
  MEDIA_PACKAGED_RESTART="sudo systemctl restart $unit" \
  pnpm --dir "$root" exec vitest run --root "$root" apps/media/src/stack/packaged-stack.test.ts

if [[ "$acceleration" != none ]]; then
  logs="$(sudo journalctl -u "$unit" --no-pager)"
  check "the sandboxed service found Quick Sync" 'grep -q "\"qsv\":true" <<<"$logs"'
  check "no transcode fell back from Quick Sync" '! grep -q "qsv_disabled\|encoder_failed" <<<"$logs"'
fi
