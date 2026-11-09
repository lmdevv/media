#!/usr/bin/env bash
# Runs the media service's tests (with real ffmpeg: encoders started, released, restarted, and
# closed, library scans, backups, downloads) under the system call sandbox nix/module.nix gives
# movies.service, on the Node and ffmpeg that unit runs. A system call the filter denies, such as
# the fchown inside libuv's copyfile, kills the process here instead of failing one call, so the
# run fails on any denied call the service or ffmpeg makes.
#
#   scripts/check-sandbox.sh                                  # every media test
#   scripts/check-sandbox.sh apps/media/src/playback          # some test files or folders
#
# Needs Nix with flakes and a systemd user manager (`systemd-run --user`). The filter, Node, and
# ffmpeg are the module's own, read with `nix eval`; group contents such as @system-service come
# from the host's systemd.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "check-sandbox: $*" >&2
  exit 1
}

module() {
  cat <<EOF
let
  flake = builtins.getFlake "git+file://$root";
  inherit (flake.inputs.nixpkgs) lib;
  evaluated = lib.nixosSystem {
    system = builtins.currentSystem;
    modules = [
      flake.nixosModules.default
      {
        boot.isContainer = true;
        system.stateVersion = "26.05";
        services.media = { enable = true; libraryDirs = [ "/srv/media/movies" ]; };
      }
    ];
  };
  inherit (evaluated) config;
in
$1
EOF
}

built() {
  nix build --no-link --print-out-paths --impure --expr "$(module "$1")"
}

# The settings systemd enforces with seccomp and no_new_privs, which a user manager can apply.
sandbox="$(nix eval --json --impure --expr "$(module '
  builtins.intersectAttrs {
    NoNewPrivileges = null;
    SystemCallArchitectures = null;
    SystemCallFilter = null;
    RestrictAddressFamilies = null;
    RestrictNamespaces = null;
    RestrictRealtime = null;
    RestrictSUIDSGID = null;
    LockPersonality = null;
    MemoryDenyWriteExecute = null;
  } config.systemd.services.movies.serviceConfig
')")"
node_dir="$(built config.services.media.package.nodejs)/bin"
ffmpeg_dir="$(built 'lib.getBin config.services.media.ffmpegPackage')/bin"
setpriv_dir="$(built 'lib.getBin (lib.findFirst (p: lib.getName p == "util-linux") null config.systemd.services.movies.path)')/bin"
[[ -x "$node_dir/node" ]] || fail "no node in $node_dir"
[[ -x "$ffmpeg_dir/ffmpeg" && -x "$ffmpeg_dir/ffprobe" ]] || fail "no ffmpeg in $ffmpeg_dir"
[[ -x "$setpriv_dir/setpriv" ]] || fail "no setpriv in $setpriv_dir"

properties=()
while IFS= read -r property; do
  properties+=(-p "$property")
done < <(
  "$node_dir/node" -e '
    const settings = JSON.parse(process.argv[1]);
    if (!Array.isArray(settings.SystemCallFilter) || settings.SystemCallFilter.length === 0) {
      console.error("check-sandbox: movies.service has no SystemCallFilter");
      process.exit(1);
    }
    for (const [name, value] of Object.entries(settings)) {
      if (typeof value === "boolean") console.log(name + "=" + (value ? "yes" : "no"));
      else if (name === "SystemCallFilter") for (const entry of value) console.log(name + "=" + entry);
      else console.log(name + "=" + (Array.isArray(value) ? value.join(" ") : value));
    }
    // The unit returns EPERM for a denied call; killing makes one the code shrugs off fail too.
    console.log("SystemCallErrorNumber=kill");
  ' "$sandbox"
)

# The service finds ffmpeg and ffprobe on PATH unless FFMPEG_PATH and FFPROBE_PATH say otherwise,
# and tests start it with their own settings, so the module's ffmpeg goes first on PATH too.
environment=(
  -E "PATH=$node_dir:$ffmpeg_dir:$setpriv_dir:$PATH"
  -E "HOME=$HOME"
  -E CI=1
  -E "FFMPEG_PATH=$ffmpeg_dir/ffmpeg"
  -E "FFPROBE_PATH=$ffmpeg_dir/ffprobe"
)
for name in TMPDIR QSV_DEVICE VAAPI_DEVICE LIBVA_DRIVER_NAME; do
  if [[ -n "${!name:-}" ]]; then environment+=(-E "$name=${!name}"); fi
done

sandboxed() {
  systemd-run --user --wait --pipe --quiet --same-dir "${environment[@]}" "${properties[@]}" "$@"
}

echo "check-sandbox: ${properties[*]}"
echo "check-sandbox: node $node_dir, ffmpeg $ffmpeg_dir"

canary="$(mktemp -d)"
trap 'rm -rf "$canary"' EXIT
cat >"$canary/chown.sh" <<'EOF'
node -e 'require("node:fs").chownSync(process.argv[1], process.getuid(), process.getgid())' "$0"
echo "$?"
EOF
status="$(sandboxed "$(command -v bash)" "$canary/chown.sh")"
[[ "$status" == 159 ]] ||
  fail "a chown under the filter exited with $status, not SIGSYS (159), so the filter is not in force"

# The ffmpeg suites skip without a working ffmpeg, and a service under test that finds none fails
# every stream; either must fail the check here. Tools run by name, as the service runs them.
cat >"$canary/tools.sh" <<'EOF'
command -v node ffmpeg ffprobe setpriv
# As the service starts each tool: the death signal, then a check that the parent is still here.
launch() { setpriv --pdeathsig KILL -- /bin/sh -c '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"' sh "$$" "$@"; }
launch ffmpeg -hide_banner -version >/dev/null && launch ffprobe -hide_banner -version >/dev/null
EOF
tools="$(sandboxed "$(command -v bash)" "$canary/tools.sh")" ||
  fail "ffmpeg or ffprobe does not run under the filter behind setpriv"
expected="$(printf '%s\n' "$node_dir/node" "$ffmpeg_dir/ffmpeg" "$ffmpeg_dir/ffprobe" "$setpriv_dir/setpriv")"
[[ "$tools" == "$expected" ]] ||
  fail "the unit finds ${tools//$'\n'/ } on PATH, not the module's node, ffmpeg and setpriv"

if [[ $# -eq 0 ]]; then
  set -- apps/media/src
fi
sandboxed "$node_dir/node" node_modules/vitest/vitest.mjs run "$@"
