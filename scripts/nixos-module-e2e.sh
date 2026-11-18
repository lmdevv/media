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
folders_unit=media-server-folders-module-e2e
units=("$unit" "$proxy_unit" "$folders_unit")
containers=(media-core-convex)
# Not under /tmp or /var/tmp: the service has its own (PrivateTmp).
base=/var/lib/media-module-e2e
# The folders the run writes outside $base: the units' runtime folders, and the web clients the
# setup writes beside them. A real install's are the same, so the run refuses a host with any.
run_dirs=(/run/media-server /run/media-proxy /run/media-account /run/media-music)
# The owner the packaged-stack suite sets the core up with.
owner_name=owner
owner_password=stack-test-password

# What this run made, and so all the cleanup removes: containers by the IDs `docker run` printed,
# never by name, and units and folders only once the checks below found them absent.
created_containers=()
created_units=()
created_dirs=()

cleanup() {
  local status=$?
  if [[ $status -ne 0 && ${#created_units[@]} -gt 0 ]]; then
    sudo journalctl -u "$folders_unit" -u "$unit" --no-pager -n 80 >&2 || true
  fi
  if [[ "${KEEP:-0}" != "1" ]]; then
    if [[ ${#created_units[@]} -gt 0 ]]; then
      sudo systemctl stop "${created_units[@]/%/.service}" >/dev/null 2>&1 || true
      for created in "${created_units[@]}"; do
        sudo rm -f "/run/systemd/system/$created.service" || true
      done
      sudo systemctl daemon-reload || true
    fi
    if [[ ${#created_containers[@]} -gt 0 ]]; then
      docker rm -f "${created_containers[@]}" >/dev/null 2>&1 || true
    fi
    if [[ ${#created_dirs[@]} -gt 0 ]]; then
      sudo rm -rf "${created_dirs[@]}" || true
    fi
  fi
  exit $status
}

# Fails closed: only Docker's own "no such object" answer counts as absent; any other failure, such
# as a daemon still starting, stops the run.
absent_container() {
  local error
  if error="$(docker inspect --format '{{.Id}}' "$1" 2>&1 >/dev/null)"; then
    return 1
  fi
  if [[ "${error,,}" == "error: no such object: ${1,,}" ]]; then
    return 0
  fi
  echo "could not tell whether a container named $1 exists (is Docker running?): $error" >&2
  exit 1
}
for container in "${containers[@]}"; do
  if ! absent_container "$container"; then
    echo "a container named $container already exists; remove it first" >&2
    exit 1
  fi
done
for dir in "${run_dirs[@]}"; do
  if [[ -e "$dir" || -L "$dir" ]]; then
    echo "$dir exists, so a real install runs here; run this on another host" >&2
    exit 1
  fi
done
if [[ -e "$base" || -L "$base" ]]; then
  echo "$base exists, from an earlier run with KEEP=1 or something else; remove it first" >&2
  exit 1
fi
for name in "${units[@]}"; do
  if [[ -e "/run/systemd/system/$name.service" ]]; then
    echo "a unit named $name exists, from an earlier run with KEEP=1 or something else; remove it first" >&2
    exit 1
  fi
done
trap cleanup EXIT

created_dirs+=("$base")
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
      foldersDrv = config.systemd.units.\"media-server-folders.service\".unit.drvPath;
      containers = builtins.mapAttrs (_: c: { inherit (c) image ports volumes environment entrypoint cmd; })
        config.virtualisation.oci-containers.containers;
    }"
)"
field() { node -e "process.stdout.write([].concat(JSON.parse(process.argv[1])[process.argv[2]]).join('\n'))" "$evaluated" "$1"; }

unit_file="$(nix build --no-link --print-out-paths "$(field unitDrv)^out")/media-server.service"
proxy_file="$(nix build --no-link --print-out-paths "$(field proxyDrv)^out")/media-proxy.service"
folders_file="$(nix build --no-link --print-out-paths "$(field foldersDrv)^out")/media-server-folders.service"

created_units+=("${units[@]}")
created_dirs+=("${run_dirs[@]}")
# The module's folder check makes the folders, the container's database folder among them, before
# anything else starts, as on a host.
sudo cp "$folders_file" "/run/systemd/system/$folders_unit.service"
sudo systemctl daemon-reload
sudo systemctl start "$folders_unit"

container_field() {
  node -e 'const c = JSON.parse(process.argv[1]).containers[process.argv[2]]; const v = c[process.argv[3]];
    process.stdout.write(Array.isArray(v) ? v.join("\n") : typeof v === "object" ?
      Object.entries(v).map(([k, x]) => k + "=" + x).join("\n") : v)' "$evaluated" "$1" "$2"
}
# container_field joins a list with newlines and no newline after the last item, which `read`
# returns only through its `|| [[ -n ... ]]`.
for container in "${containers[@]}"; do
  env_args=() volume_args=() cmd_args=()
  while IFS= read -r pair || [[ -n "$pair" ]]; do env_args+=(-e "$pair"); done < <(container_field "$container" environment)
  while IFS= read -r volume || [[ -n "$volume" ]]; do volume_args+=(-v "$volume"); done < <(container_field "$container" volumes)
  while IFS= read -r arg || [[ -n "$arg" ]]; do cmd_args+=("$arg"); done < <(container_field "$container" cmd)
  # `docker create` prints the ID of the container it made, even one that then fails to start, and
  # nothing when it made none, such as for a name already taken.
  id="$(docker create --name "$container" -p "$(container_field "$container" ports)" "${volume_args[@]}" \
    --entrypoint "$(container_field "$container" entrypoint)" "${env_args[@]}" \
    "$(container_field "$container" image)" "${cmd_args[@]}")"
  created_containers+=("$id")
  docker start "$id" >/dev/null
done

# The run starts the container itself, so the unit drops it from Requires= and After= and waits on
# the run's folder check.
sed -e '/^\(Requires\|After\)=/s/docker-media-core-convex\.service *//' \
  -e "s/media-server-folders\.service/$folders_unit.service/g" "$unit_file" |
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
  local description=$1
  shift
  if ! "$@"; then
    echo "check failed: $description" >&2
    exit 1
  fi
  echo "ok: $description"
}
not() { ! "$@"; }
equals() { [[ "$1" == "$2" ]]; }

answers() { curl -fsS "$media_url$1" 2>/dev/null | grep -qF "$2"; }
owner_and_mode() { sudo stat -c "%U %a" "$@" | sort -u; }
serves_jwks() { curl -fsS "$media_url/convex/.well-known/jwks.json" 2>/dev/null | grep -qF '"keys"'; }
check "/convex is the core's Convex backend" equals "$(curl -fsS "$media_url/convex/instance_name")" core
check "/ is the account client" answers / "<title>[media]</title>"
check "/movies is the movies client" answers /movies/ "<title>[movies]</title>"
check "Convex HTTP actions stay inside the containers" not serves_jwks

pid="$(systemctl show -p MainPID --value "$unit")"
env_file=/run/media-server/media.env
signs_in_with_stored_key() {
  [[ "$(sudo sed -n "s/^MEDIA_SERVICE_API_KEY=//p" "$env_file")" == "$(sudo cat "$base/data/core/secrets/media-service-key")" ]] &&
    sudo grep -q "^MEDIA_TICKET_KEYS=." "$env_file" &&
    ! sudo grep -q "^PLAYBACK_TOKEN_SECRET=" "$env_file"
}
writes_as_service() { sudo nsenter -t "$pid" -m touch "$1" 2>/dev/null; }
secret_in_cmdline() { sudo cat "/proc/$pid/cmdline" | tr "\0" "\n" | grep -q "KEY\|SECRET"; }
foreign_entries() {
  sudo find "$base/data/server" "$base/data/core/backups" "$base/transcode" \
    \( ! -user nobody -o ! -group nogroup \) -printf . | wc -c
}
check "the media service runs as its own user" equals "$(sudo stat -c %U "/proc/$pid")" nobody
check "the service environment is private" equals "$(owner_and_mode "$env_file")" "nobody 600"
check "backups are the service user's and private" equals "$(owner_and_mode "$base/data/core/backups")" "nobody 700"
check "the service's folders are its user's" equals "$(foreign_entries)" 0
folder_modes() {
  local dir
  for dir in "$@"; do sudo stat -c "%n %U %a" "$dir"; done
}
check "root's folders are root's" \
  equals "$(folder_modes "$base/data" "$base/data/core" "$base/data/core/convex" "$base/data/core/secrets")" \
  "$(printf '%s\n' "$base/data root 711" "$base/data/core root 711" "$base/data/core/convex root 700" \
    "$base/data/core/secrets root 700")"
check "the service's folders are its user's alone" \
  equals "$(folder_modes "$base/data/server" "$base/data/core/backups" "$base/transcode")" \
  "$(printf '%s\n' "$base/data/server nobody 700" "$base/data/core/backups nobody 700" "$base/transcode nobody 700")"
check "the media service's key is root's and private" \
  equals "$(owner_and_mode "$base/data/core/secrets/media-service-key" "$base/data/core/secrets/media-service-id")" "root 600"
check "the media service signs in to the core with its stored key and the core's ticket keys" signs_in_with_stored_key
check "the library is mounted read-only for the service, even for root" not writes_as_service "$base/library/written"
check "the rest of the system is read-only for the service" not writes_as_service "$base/outside"
check "no secret is in the command line" not secret_in_cmdline
setup_script="$(sed -n 's/^ExecStartPre=+//p' "$unit_file")"
# The admin key and the service key as `grep -f` patterns, through a pipe only: a check for a
# secret never puts it in an argument (docs/security.md).
secrets="$(mktemp -d)"
(
  umask 077
  sudo sed -n -e 's/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p' -e 's/^MEDIA_SERVICE_API_KEY=//p' "$env_file" |
    tee "$secrets/patterns" >/dev/null
)
secret_in_unit() { sudo grep -qF -f "$secrets/patterns" "$unit_file" "$folders_file" "$setup_script"; }
check "the secrets to look for were read" test -s "$secrets/patterns"
check "no secret is in the units or the startup script" not secret_in_unit
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
  check "the sandboxed service found Quick Sync" grep -qF '"qsv":true' <<<"$logs"
  check "no transcode fell back from Quick Sync" not grep -q "qsv_disabled\|encoder_failed" <<<"$logs"
fi
