#!/usr/bin/env bash
# Runs disposable [music] instances for verification and drives them. See ../SKILL.md.
#
#   verify-music.sh up [--side after|before] [--image IMG] [--library demo|fixtures|DIR] [--port N] [--no-setup]
#   verify-music.sh doctor [--side S]
#   verify-music.sh browser [--side S] <command> [flags]
#   verify-music.sh cli [--side S] -- <music args>
#   verify-music.sh logs [--side S] [lines]
#   verify-music.sh ios <up|doctor|tap|type|swipe|describe|wait|shot|record|appearance|remote|down> [--side S] ...
#   verify-music.sh evidence <add|list|clear|publish> ...
#   verify-music.sh status
#   verify-music.sh down [--side S] [--purge]
#
# MUSIC_VERIFY_RUN names the run (default: the checkout's directory name). A run has two sides:
# `after` is an image built from this checkout, `before` is ghcr.io/lmdevv/music:main.
set -euo pipefail

skill="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$skill/../../.." && pwd)"
scripts="$skill/scripts"

slug() { tr '[:upper:]' '[:lower:]' <<<"$1" | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//'; }
run="$(slug "${MUSIC_VERIFY_RUN:-$(basename "$root")}")"
[[ -n "$run" ]] || { echo "MUSIC_VERIFY_RUN is empty after cleaning" >&2; exit 2; }
state_root="${TMPDIR:-/tmp}/music-verify/$run"
evidence_root="$root/captures/verify/$run"
mac="${MAC_HOST:-darwin}"
axe='$HOME/music-ios/tools/axe/axe'
before_image_default="ghcr.io/lmdevv/music:main"
demo_dir="${MUSIC_DEMO_DIR:-$HOME/music-demo/demo-music}"

die() { echo "verify-music: $*" >&2; exit 1; }
say() { echo "verify-music: $*" >&2; }

# Pulls a leading --side out of the arguments; the rest stay in `args`.
side="after"
args=()
take_side() {
  args=()
  while (($#)); do
    case "$1" in
      --side) side="${2:?--side needs after or before}"; shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  [[ "$side" == after || "$side" == before ]] || die "--side must be after or before, not $side"
  state="$state_root/$side"
  evidence="$evidence_root/$side"
  name="music-verify-$run-$side"
}

read_state() { cat "$state/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" > "$state/$1"; }

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
    console.log(s.address().port); s.close(); });'
}

# HEAD plus a hash of uncommitted changes, so doctor can tell when the checkout moved after `up`.
# The revision of what the image is built from. `.dockerignore` leaves out `.agents` and `.claude`,
# so a commit that only edits a skill keeps the revision and the after side stays current.
checkout_rev() {
  local tree dirty
  tree="$(git -C "$root" ls-tree HEAD | grep -vE $'\t\\.(agents|claude)$' | sha1sum | cut -c1-12)"
  dirty="$(git -C "$root" status --porcelain --untracked-files=normal -- . ':!captures' ':!.agents' ':!.claude' \
    | sha1sum | cut -c1-12)"
  echo "$tree+$dirty"
}

chromium_path() {
  if [[ -n "${CHROMIUM_PATH:-}" ]]; then echo "$CHROMIUM_PATH"; return; fi
  # Playwright's bundled Chromium does not run on NixOS; its system Chromium does.
  if [[ -e /etc/NIXOS ]] && command -v chromium >/dev/null; then command -v chromium; fi
}

url() { echo "http://localhost:$(read_state port)"; }

wait_healthy() {
  local port="$1"
  for _ in $(seq 1 150); do
    curl -fsS "http://localhost:$port/healthz" 2>/dev/null | grep -q '"ok":true' && return 0
    docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true ||
      { docker logs --tail 40 "$name" >&2 || true; die "$name stopped while starting"; }
    sleep 2
  done
  docker logs --tail 40 "$name" >&2 || true
  die "$name did not become healthy in 5 minutes"
}

browser() {
  CHROMIUM_PATH="$(chromium_path)" node "$scripts/browser.mjs" "$1" --state "$state" "${@:2}"
}

start_browser() {
  rm -f "$state/browser.port"
  CHROMIUM_PATH="$(chromium_path)" nohup node "$scripts/browser.mjs" serve --state "$state" \
    --base "$(url)" > "$state/browser.log" 2>&1 &
  write_state browser.pid "$!"
  for _ in $(seq 1 100); do
    [[ -s "$state/browser.port" ]] && return 0
    kill -0 "$(read_state browser.pid)" 2>/dev/null || { cat "$state/browser.log" >&2; die "the browser host exited"; }
    sleep 0.2
  done
  die "the browser host did not start; see $state/browser.log"
}

# ---------------------------------------------------------------------------------------------- up

cmd_up() {
  take_side "$@"
  local image="" library="" port="" setup=1
  set -- "${args[@]}"
  while (($#)); do
    case "$1" in
      --image) image="$2"; shift 2 ;;
      --library) library="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      --no-setup) setup=0; shift ;;
      *) die "up: unknown flag $1" ;;
    esac
  done
  docker inspect "$name" >/dev/null 2>&1 && die "$name already exists; run \`down --side $side\` first"
  mkdir -p "$state" "$evidence"

  local built=0
  if [[ -z "$image" && "$side" == before ]]; then
    image="$before_image_default"
    say "pulling $image"
    docker pull -q "$image" >/dev/null
  elif [[ -z "$image" ]]; then
    image="music:verify-$run"
    say "building $image from $root"
    docker build -q -f "$root/deploy/docker/Dockerfile" --label "music.verify.run=$run" \
      --label "music.verify.rev=$(checkout_rev)" -t "$image" "$root" >/dev/null
    built=1
  fi
  write_state image "$image"
  write_state built "$built"
  write_state image_id "$(docker image inspect -f '{{.Id}}' "$image")"
  write_state rev "$(checkout_rev)"

  case "${library:-}" in
    "") if [[ -d "$demo_dir" ]]; then library="$demo_dir"; else library=fixtures; fi ;;
    demo) [[ -d "$demo_dir" ]] || die "no demo library at $demo_dir; run scripts/download-demo-music.sh $demo_dir"
      library="$demo_dir" ;;
  esac
  if [[ "$library" == fixtures ]]; then
    library="$state/library"
    rm -rf "$library"
    node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
  fi
  library="$(cd "$library" && pwd)"
  # The media service runs unprivileged in the container and must read every folder and file.
  if [[ -n "$(find "$library" \( \( -type d \! -perm -o+rx \) -o \( -type f \! -perm -o+r \) \) -print -quit)" ]]; then
    if [[ "$library" == "$state/library" ]]; then chmod -R a+rX "$library"
    else die "$library is not readable by others; run chmod -R a+rX on it"; fi
  fi
  write_state library "$library"

  port="${port:-$(free_port)}"
  write_state port "$port"
  # PUBLIC_URL must be the address clients use: sign-in tokens are issued for it. localhost works
  # for the browser here and, through `ios up`'s ssh forward, for the simulator on the Mac.
  docker run -d --name "$name" --label "music.verify.run=$run" --label "music.verify.side=$side" \
    -p "127.0.0.1:$port:8080" -v "$name-data:/data" -v "$library:/music:ro" -e TZ=UTC \
    -e PUBLIC_URL="http://localhost:$port" "$image" >/dev/null
  say "waiting for $name on port $port"
  wait_healthy "$port"

  [[ -f "$root/apps/cli/dist/music.js" ]] || pnpm --dir "$root" --filter @music/cli build >/dev/null
  start_browser
  if ((setup)); then
    say "running first-run setup through the web app and scanning /music"
    browser setup >/dev/null
    write_state key "$(browser create-key)"
    cmd_cli_raw whoami | grep -q admin@music.local || die "the API key does not sign the CLI in"
  fi
  echo "ready: $(url) (run $run, side $side, container $name, image $image, library $library, evidence $evidence)"
}

# ------------------------------------------------------------------------------------------ doctor

cmd_doctor() {
  take_side "$@"
  local failed=0 port image_id
  check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; failed=1; fi; }
  port="$(read_state port)"
  image_id="$(read_state image_id)"
  [[ -n "$port" ]] || die "no $side side in run $run; run \`up --side $side\`"
  check "container $name runs" "docker inspect -f '{{.State.Running}}' $name | grep -q true"
  check "container belongs to run $run" "[[ \$(docker inspect -f '{{index .Config.Labels \"music.verify.run\"}}' $name) == $run ]]"
  check "port $port maps to $name" "docker port $name 8080/tcp | grep -q ':$port\$'"
  check "/healthz is ok" "curl -fsS http://localhost:$port/healthz | grep -q '\"ok\":true'"
  check "container runs the image from up" "[[ \$(docker inspect -f '{{.Image}}' $name) == $image_id ]]"
  check "init deployed this build" "[[ \$(docker exec $name cat /data/build) == \$(docker exec $name cat /app/build-id) ]]"
  check "browser host answers" "browser url"
  if [[ -n "$(read_state key)" ]]; then
    check "API key signs the CLI in as admin" "cmd_cli_raw whoami | grep -q admin@music.local"
  else
    echo "skip  API key (up ran with --no-setup)"
  fi
  if [[ "$(read_state built)" == 1 ]]; then
    if [[ "$(read_state rev)" == "$(checkout_rev)" ]]; then echo "ok    image matches the checkout"
    else echo "FAIL  the checkout changed since up; run \`down --side $side\` and \`up --side $side\` to test it"; failed=1; fi
  fi
  echo "info  version $(docker exec "$name" node -p 'require("/app/backend/package.json").version' 2>/dev/null), build $(docker exec "$name" cat /app/build-id 2>/dev/null), image $(read_state image)"
  return "$failed"
}

# -------------------------------------------------------------------------------- browser, cli, logs

cmd_browser() {
  take_side "$@"
  [[ -s "$state/browser.port" ]] || die "no browser host on the $side side; run \`up --side $side\`"
  if [[ "${args[0]:-}" == restart ]]; then
    local pid tries=0
    pid="$(read_state browser.pid)"
    kill "$pid" 2>/dev/null || true
    # The old host removes browser.port as it exits, so wait for it before the new host writes one.
    while kill -0 "$pid" 2>/dev/null; do
      (( ++tries <= 300 )) || die "the browser host $pid did not stop"
      sleep 0.1
    done
    start_browser
    [[ -n "$(read_state key)" ]] && browser sign-in >/dev/null
    echo "browser host restarted; page main is signed in again"
    return
  fi
  browser "${args[@]}"
}

cmd_cli_raw() {
  MUSIC_SERVER="$(url)/convex" MUSIC_API_KEY="$(read_state key)" XDG_CONFIG_HOME="$state/cli-config" \
    node "$root/apps/cli/dist/music.js" "$@"
}

cmd_cli() {
  take_side "$@"
  set -- "${args[@]}"
  [[ "${1:-}" == "--" ]] && shift
  [[ -n "$(read_state key)" ]] || die "no API key on the $side side; up ran with --no-setup"
  cmd_cli_raw "$@"
}

cmd_logs() {
  take_side "$@"
  docker logs --tail "${args[0]:-80}" "$name" 2>&1
}

cmd_status() {
  local s
  for s in after before; do
    take_side --side "$s"
    [[ -n "$(read_state port)" ]] || continue
    echo "$s: $(url) container $name ($(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo gone)) image $(read_state image)"
    [[ -n "$(read_state ios_udid)" ]] && echo "$s ios: simulator $(read_state ios_udid), metro $(read_state metro_port)"
  done
  echo "evidence: $evidence_root"
}

# --------------------------------------------------------------------------------------------- ios

on_mac() { ssh "$mac" "export PATH=/opt/homebrew/bin:\$PATH LANG=en_US.UTF-8; set -euo pipefail; $1"; }

udid() {
  local id
  id="$(read_state ios_udid)"
  [[ -n "$id" ]] || die "no simulator on the $side side; run \`ios up --side $side\`"
  echo "$id"
}

# Prints the UI tree of the booted app as one "label | type | frame" line per element.
ios_tree() {
  on_mac "$axe describe-ui --udid $(udid)" | node -e '
    const roots = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const walk = (node, depth) => {
      const label = node.AXLabel ?? "", value = node.AXValue ?? "", id = node.AXUniqueId ?? "";
      const f = node.frame ?? {};
      if (label || value || id) console.log(`${"  ".repeat(depth)}${label}${value ? ` = ${value}` : ""} | ${node.type ?? node.role ?? ""}${id ? ` #${id}` : ""} | ${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)}`);
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    for (const root of [].concat(roots)) walk(root, 0);'
}

ios_wait() {
  local label="$1" seconds="${2:-60}"
  for _ in $(seq 1 "$seconds"); do
    ios_tree 2>/dev/null | grep -qF -- "$label" && return 0
    sleep 1
  done
  die "\"$label\" did not appear on the simulator within ${seconds}s"
}

# Prints the centre of the element labeled $1 as "x y". A field's label can carry its error after a
# comma, so a label that starts with "$1," matches too. Text that only names a field, such as the
# caption above it, loses to the field, a button, or another control with the same label.
ios_find() {
  on_mac "$axe describe-ui --udid $(udid)" | node -e '
    const [label] = process.argv.slice(1);
    const controls = ["TextField", "SecureTextField", "Button", "Cell", "Link", "Switch", "Slider", "TabBarButton", "Tab"];
    const found = [];
    const walk = (node) => {
      const name = node.AXLabel ?? "";
      if (name === label || name.startsWith(`${label},`)) found.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    for (const root of [].concat(JSON.parse(require("node:fs").readFileSync(0, "utf8")))) walk(root);
    const rank = (node) => { const i = controls.indexOf(node.type ?? node.role ?? ""); return i < 0 ? 99 : i; };
    found.sort((a, b) => rank(a) - rank(b));
    const f = found[0]?.frame;
    if (!f) { console.error(`no element labeled "${label}" on screen`); process.exit(1); }
    console.log(`${Math.round(f.x + f.width / 2)} ${Math.round(f.y + f.height / 2)}`);' "$1"
}

ios_tap_label() {
  local point
  point="$(ios_find "$1")" || die "no element labeled \"$1\" on the simulator; run \`ios describe\`"
  on_mac "$axe tap -x ${point% *} -y ${point#* } --udid $(udid)" >/dev/null
}

# Replaces the focused field's text. AXe types faster than the app's fields take keystrokes and
# drops characters, so the text goes through the simulator's pasteboard and Cmd+V instead.
ios_type() {
  printf %s "$1" | on_mac "xcrun simctl pbcopy $(udid)"
  on_mac "$axe key-combo --modifiers 227 --key 4 --udid $(udid) && $axe key-combo --modifiers 227 --key 25 --udid $(udid)" >/dev/null
}

# Taps whichever of the given labels is on screen; returns 1 when none is.
ios_tap_any() {
  local label point
  for label in "$@"; do
    if point="$(ios_find "$label" 2>/dev/null)"; then
      on_mac "$axe tap -x ${point% *} -y ${point#* } --udid $(udid)" >/dev/null
      return 0
    fi
  done
  return 1
}

# A main checkout for the before side's Metro, so the simulator runs main's JavaScript.
before_source() {
  local src="$state/src"
  if [[ ! -d "$src" ]]; then
    git -C "$root" fetch -q origin main
    git -C "$root" worktree add -q --detach "$src" origin/main
    pnpm --dir "$src" install --frozen-lockfile --prefer-offline --ignore-scripts >/dev/null
  fi
  echo "$src"
}

cmd_ios_up() {
  local sim_type="iPhone 17 Pro" dark=0
  set -- "${args[@]:1}"
  while (($#)); do
    case "$1" in
      --device) sim_type="$2"; shift 2 ;;
      --dark) dark=1; shift ;;
      *) die "ios up: unknown flag $1" ;;
    esac
  done
  [[ -n "$(read_state key)" ]] || die "start the $side side first: \`up --side $side\` (with setup)"
  [[ -z "$(read_state ios_udid)" ]] || die "the $side side already has a simulator; run \`ios down --side $side\`"
  on_mac "test -x $axe" || die "AXe is missing on $mac at ~/music-ios/tools/axe/axe; unpack the release from github.com/cameroncooke/AXe there"

  local port metro src
  port="$(read_state port)"
  metro="$(free_port)"
  write_state metro_port "$metro"
  # The simulator shares the Mac's network, so localhost:<port> on the Mac reaches this machine.
  nohup ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -R "$port:127.0.0.1:$port" -R "$metro:127.0.0.1:$metro" "$mac" > "$state/forward.log" 2>&1 &
  write_state forward_pid "$!"
  sleep 2
  kill -0 "$(read_state forward_pid)" 2>/dev/null || { cat "$state/forward.log" >&2; die "the ssh forward to $mac failed"; }

  src="$root"
  [[ "$side" == before ]] && src="$(before_source)"
  say "starting Metro for $src on port $metro"
  # Not CI=1: that turns off file watching and the app keeps serving the first bundle.
  # Its own session, so `ios down` stops pnpm, Expo, and Metro's workers as one process group. The
  # log takes all its output, so nothing that reads this script's output waits on it.
  setsid bash -c 'cd "$1" && REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 exec pnpm --filter mobile exec \
    expo start --port "$2"' metro "$src" "$metro" < /dev/null > "$state/metro.log" 2>&1 &
  write_state metro_pid "$!"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running || { tail -20 "$state/metro.log" >&2; die "Metro did not start"; }

  local id
  id="$(on_mac "xcrun simctl create music-verify-$run-$side $(printf %q "$sim_type")")"
  write_state ios_udid "$id"
  on_mac "xcrun simctl boot $id && xcrun simctl bootstatus $id -b >/dev/null"
  ((dark)) && on_mac "xcrun simctl ui $id appearance dark"

  # One dev client per run, built from this checkout; JavaScript comes from each side's Metro.
  local app="\$HOME/music-ios/dd-verify-$run/Build/Products/Debug-iphonesimulator/music.app"
  if on_mac "test -d $app"; then
    on_mac "xcrun simctl install $id $app"
  else
    say "building the iOS dev client on $mac (minutes on a cold build)"
    MUSIC_IOS_NAME="verify-$run" "$root/scripts/ios-mac.sh" build-sim "$id" >&2
  fi
  # Keep the dev client's own UI out of the evidence: no introduction over the app at first
  # launch, no floating button over the screens, and no gesture that opens its menu mid-recording.
  local key
  for key in IsOnboardingFinished:YES ShowsAtLaunch:NO ShowFloatingActionButton:NO \
    MotionGestureEnabled:NO TouchGestureEnabled:NO; do
    on_mac "xcrun simctl spawn $id defaults write dev.lmdevv.music EXDevMenu${key%%:*} -bool ${key#*:}"
  done
  "$root/scripts/ios-mac.sh" open "$id" "http://127.0.0.1:$metro" >/dev/null
  # iOS asks once whether to open the link in the app. Tap only that prompt's button.
  local tree
  for _ in $(seq 1 90); do
    tree="$(ios_tree 2>/dev/null || true)"
    grep -qE 'Connect to your server|Welcome back' <<<"$tree" && break
    grep -q 'Open in' <<<"$tree" && ios_tap_label "Open" >/dev/null 2>&1
    sleep 2
  done

  say "connecting to $(url) and signing in"
  ios_tap_any "Connect to your server" >/dev/null || true
  ios_sign_in
  echo "ready: ios $side on simulator $id (Metro $metro, server $(url))"
}

ios_sign_in() {
  local tree
  tree="$(ios_tree)"
  if ! grep -q 'Welcome back' <<<"$tree"; then
    ios_tap_label "Server address"
    ios_type "$(url)"
    ios_tap_label "Connect"
    ios_wait "Welcome back" 60
  fi
  ios_tap_label "Email"
  ios_type "admin@music.local"
  ios_tap_label "Password"
  ios_type "password123"
  ios_tap_label "Sign in"
  for _ in $(seq 1 60); do
    if ios_tree 2>/dev/null | grep -q 'Tab Bar'; then
      # The first touch after signing in is dropped (seen every run, cause unknown), so spend it
      # on the page title, which does nothing when tapped.
      ios_tap_label "Home"
      return 0
    fi
    sleep 1
  done
  die "the app did not reach the library after signing in; run \`ios describe --side $side\`"
}

cmd_ios() {
  take_side "$@"
  local sub="${args[0]:-}"
  case "$sub" in
    up) cmd_ios_up ;;
    doctor)
      local failed=0 id
      id="$(udid)"
      kill -0 "$(read_state forward_pid)" 2>/dev/null && echo "ok    ssh forward to $mac" || { echo "FAIL  ssh forward to $mac"; failed=1; }
      curl -fsS "http://127.0.0.1:$(read_state metro_port)/status" 2>/dev/null | grep -q running && echo "ok    Metro on $(read_state metro_port)" || { echo "FAIL  Metro"; failed=1; }
      on_mac "xcrun simctl list devices | grep -q '$id) (Booted)'" && echo "ok    simulator $id booted" || { echo "FAIL  simulator $id"; failed=1; }
      on_mac "curl -fsS $(url)/healthz | grep -q ok" && echo "ok    the Mac reaches $(url)" || { echo "FAIL  the Mac reaches $(url)"; failed=1; }
      return "$failed" ;;
    describe) ios_tree ;;
    sign-in) ios_sign_in && echo "signed in on $(udid)" ;;
    find) ios_find "${args[1]:?ios find <label>}" ;;
    tap)
      case "${args[1]:-}" in
        --label) ios_tap_label "${args[2]:?}" ;;
        --id) on_mac "$axe tap --id $(printf %q "${args[2]:?}") --udid $(udid)" ;;
        -x) on_mac "$axe tap -x ${args[2]:?} -y ${args[4]:?} --udid $(udid)" ;;
        *) die "ios tap --label L | --id ID | -x X -y Y" ;;
      esac ;;
    type) ios_type "${args[1]:?ios type <text>}" ;;
    swipe) on_mac "$axe swipe --start-x ${args[1]:?} --start-y ${args[2]:?} --end-x ${args[3]:?} --end-y ${args[4]:?} --duration 0.4 --udid $(udid)" ;;
    wait) ios_wait "${args[1]:?ios wait <label> [seconds]}" "${args[2]:-60}" ;;
    shot)
      local path="${args[1]:?ios shot <path.png>}"
      mkdir -p "$(dirname "$path")"
      on_mac "xcrun simctl io $(udid) screenshot --type=png /tmp/music-verify-$run-$side.png >/dev/null 2>&1"
      scp -q "$mac:/tmp/music-verify-$run-$side.png" "$path"
      echo "$path" ;;
    record)
      case "${args[1]:-}" in
        start)
          on_mac "rm -f /tmp/music-verify-$run-$side.mp4; nohup xcrun simctl io $(udid) recordVideo --codec h264 --force /tmp/music-verify-$run-$side.mp4 > /tmp/music-verify-$run-$side.rec.log 2>&1 &"
          write_state ios_record "${args[2]:?ios record start <path.mp4>}"
          sleep 2 ;;
        stop)
          local out
          out="$(read_state ios_record)"
          [[ -n "$out" ]] || die "no recording in progress on the $side side"
          on_mac "pkill -INT -f 'recordVideo.*music-verify-$run-$side.mp4' || true; sleep 3"
          mkdir -p "$(dirname "$out")"
          scp -q "$mac:/tmp/music-verify-$run-$side.mp4" "$out"
          rm -f "$state/ios_record"
          echo "$out" ;;
        *) die "ios record start <path.mp4> | stop" ;;
      esac ;;
    appearance) on_mac "xcrun simctl ui $(udid) appearance ${args[1]:?ios appearance light|dark}" ;;
    remote) "$root/scripts/ios-mac.sh" remote "$(udid)" "${args[1]:?ios remote play|pause|toggle|next|previous}" ;;
    down) ios_down ;;
    *) die "ios: unknown command ${sub:-<none>}" ;;
  esac
}

ios_down() {
  local id pid
  id="$(read_state ios_udid)"
  if [[ -n "$id" ]]; then
    on_mac "pkill -INT -f 'recordVideo.*music-verify-$run-$side' || true; xcrun simctl shutdown $id 2>/dev/null || true; xcrun simctl delete $id" || true
  fi
  # Metro leads its own process group; pnpm ignores SIGTERM, so the group gets SIGKILL after it.
  pid="$(read_state metro_pid)"
  if [[ -n "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  pid="$(read_state forward_pid)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  rm -f "$state/ios_udid" "$state/metro_pid" "$state/metro_port" "$state/forward_pid" "$state/ios_record"
}

# ----------------------------------------------------------------------------------------- evidence

cmd_evidence() {
  node "$scripts/evidence.mjs" "$@" --root "$root" --run "$run" --evidence "$evidence_root"
}

# --------------------------------------------------------------------------------------------- down

side_down() {
  take_side --side "$1"
  [[ -d "$state" ]] || return 0
  ios_down
  local pid
  pid="$(read_state browser.pid)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-data" >/dev/null 2>&1 || true
  [[ "$(read_state built)" == 1 ]] && docker image rm "$(read_state image)" >/dev/null 2>&1 || true
  [[ -d "$state/src" ]] && git -C "$root" worktree remove --force "$state/src" 2>/dev/null || true
  rm -rf "$state"
  say "removed the $side side (evidence kept in $evidence)"
}

cmd_down() {
  local only="" purge=0
  while (($#)); do
    case "$1" in
      --side) only="$2"; shift 2 ;;
      --purge) purge=1; shift ;;
      *) die "down: unknown flag $1" ;;
    esac
  done
  if [[ -n "$only" ]]; then side_down "$only"; else side_down after; side_down before; fi
  if ((purge)); then
    on_mac "rm -rf ~/music-ios/verify-$run ~/music-ios/dd-verify-$run" || true
    say "removed the iOS build cache on $mac"
  fi
  [[ -z "$only" ]] && rmdir "$state_root" 2>/dev/null || true
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  up) cmd_up "$@" ;;
  doctor) cmd_doctor "$@" ;;
  browser) cmd_browser "$@" ;;
  cli) cmd_cli "$@" ;;
  logs) cmd_logs "$@" ;;
  ios) cmd_ios "$@" ;;
  evidence) cmd_evidence "$@" ;;
  status) cmd_status ;;
  down) cmd_down "$@" ;;
  *) sed -n '2,15p' "$0" >&2; exit 2 ;;
esac
