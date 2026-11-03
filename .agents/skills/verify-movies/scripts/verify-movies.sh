#!/usr/bin/env bash
# Runs disposable [movies] stacks for verification and drives them. See ../SKILL.md.
#
#   verify-movies.sh up [--side after|before] [--image IMG] [--library demo|fixtures|DIR] [--no-setup] [--no-seed]
#   verify-movies.sh doctor [--side S]
#   verify-movies.sh browser [--side S] <command> [flags]
#   verify-movies.sh cli [--side S] [--as PERSON] -- <movies args>
#   verify-movies.sh logs [--side S] [--service movies|convex] [lines]
#   verify-movies.sh ios <up|doctor|describe|find|tap|type|swipe|wait|shot|record|appearance|orientation|open|matrix|sign-in|down> [--side S] ...
#   verify-movies.sh evidence <add|list|clear|publish> ...
#   verify-movies.sh status
#   verify-movies.sh down [--side S] [--purge]
#
# MOVIES_VERIFY_RUN names the run (default: the checkout's directory name). A run has two sides:
# `after` is an image built from this checkout, `before` is ghcr.io/lmdevv/movies:main. Each side
# is its own Compose project of deploy/compose/compose.yaml, named movies-verify-<run>-<side>.
set -euo pipefail

skill="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$skill/../../.." && pwd)"
scripts="$skill/scripts"

slug() { tr '[:upper:]' '[:lower:]' <<<"$1" | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//'; }
run="$(slug "${MOVIES_VERIFY_RUN:-$(basename "$root")}")"
[[ -n "$run" ]] || { echo "MOVIES_VERIFY_RUN is empty after cleaning" >&2; exit 2; }
state_root="${TMPDIR:-/tmp}/movies-verify/$run"
evidence_root="$root/captures/verify/$run"
mac="${MAC_HOST:-darwin}"
axe='$HOME/music-ios/tools/axe/axe'
mac_dir="movies-ios"
before_image_default="ghcr.io/lmdevv/movies:main"
demo_image="$(<"$root/deploy/demo-library/image")"
cli_js="$root/apps/cli/dist/movies.js"
password="password123"

die() { echo "verify-movies: $*" >&2; exit 1; }
say() { echo "verify-movies: $*" >&2; }

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
  project="movies-verify-$run-$side"
}

read_state() { cat "$state/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" > "$state/$1"; }

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
    console.log(s.address().port); s.close(); });'
}

# The revision of what the image is built from. The top-level paths that `.dockerignore` leaves
# out (such as .agents, .claude, docs, and nix) don't count, so a commit that only edits a skill or
# the docs keeps the revision and the after side stays current.
checkout_rev() {
  local ignored=() tree dirty pattern path
  while read -r pattern; do
    [[ "$pattern" =~ ^[A-Za-z0-9._-]+$ ]] && ignored+=("$pattern")
  done < "$root/.dockerignore"
  tree="$(git -C "$root" ls-tree HEAD | while IFS=$'\t' read -r meta path; do
    printf '%s\n' "${ignored[@]}" | grep -qxF -- "$path" || printf '%s\t%s\n' "$meta" "$path"
  done | sha1sum | cut -c1-12)"
  local excludes=(':!captures')
  for path in "${ignored[@]}"; do excludes+=(":!$path"); done
  dirty="$(git -C "$root" status --porcelain --untracked-files=normal -- . "${excludes[@]}" | sha1sum | cut -c1-12)"
  echo "$tree+$dirty"
}

chromium_path() {
  if [[ -n "${CHROMIUM_PATH:-}" ]]; then echo "$CHROMIUM_PATH"; return; fi
  # Playwright's bundled Chromium does not run on NixOS; its system Chromium does.
  if [[ -e /etc/NIXOS ]] && command -v chromium >/dev/null; then command -v chromium; fi
}

url() { echo "http://localhost:$(read_state port)"; }
convex_url() { echo "http://localhost:$(read_state convex_port)"; }
container() { echo "$project-$1-1"; }

# Compose for this side only: its own project, the settings `up` wrote, the demo library's own
# override (deploy/compose/compose.demo.yaml, as self-hosters use it) or a bind mount of another
# library, and an override that labels the containers. Settings in the caller's shell or in a
# deploy/compose/.env file would change what runs, so neither reaches Compose.
compose() {
  local unset=() name files=(-f "$root/deploy/compose/compose.yaml")
  while read -r name; do unset+=(-u "$name"); done < <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$root/deploy/compose/.env.example")
  [[ "$(read_state library)" == "$demo_image" ]] && files+=(-f "$root/deploy/compose/compose.demo.yaml")
  env "${unset[@]}" -u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES \
    docker compose -p "$project" --env-file "$state/compose.env" "${files[@]}" -f "$state/compose.verify.yaml" "$@"
}

healthy() { curl -fsS "$(url)/api/health" 2>/dev/null | grep -q '"backend":"connected"'; }

wait_healthy() {
  local status
  for _ in $(seq 1 180); do
    healthy && return 0
    status="$(docker inspect -f '{{.State.Status}}' "$(container movies)" 2>/dev/null || echo missing)"
    if [[ "$status" == exited || "$status" == dead ]]; then
      compose logs --no-color --tail 40 movies convex >&2 || true
      die "$(container movies) stopped while starting"
    fi
    sleep 2
  done
  compose logs --no-color --tail 40 movies convex >&2 || true
  die "$project did not become healthy in 6 minutes"
}

browser() {
  CHROMIUM_PATH="$(chromium_path)" node "$scripts/browser.mjs" "$1" --state "$state" "${@:2}"
}

start_browser() {
  rm -f "$state/browser.sock"
  CHROMIUM_PATH="$(chromium_path)" nohup node "$scripts/browser.mjs" serve --state "$state" \
    --base "$(url)" --convex "$(convex_url)" > "$state/browser.log" 2>&1 &
  write_state browser.pid "$!"
  for _ in $(seq 1 100); do
    [[ -S "$state/browser.sock" ]] && return 0
    kill -0 "$(read_state browser.pid)" 2>/dev/null || { cat "$state/browser.log" >&2; die "the browser host exited"; }
    sleep 0.2
  done
  die "the browser host did not start; see $state/browser.log"
}

# The CLI for one person, with their own config folder, so sessions never mix. Lucía is the owner.
as="lucia"
cli_raw() {
  env -u MOVIES_CONVEX_URL -u MOVIES_MEDIA_URL -u MOVIES_API_KEY -u MOVIES_PROFILE -u MOVIES_PASSWORD \
    XDG_CONFIG_HOME="$state/cli/$as" node "$cli_js" "$@"
}

# Signs a person's CLI in with their password, the way `movies login` documents it.
cli_login() {
  local email="$1"
  mkdir -p "$state/cli/$as"
  printf %s "$password" | cli_raw login --server "$(convex_url)" --media-url "$(url)" --email "$email" --password >/dev/null
}

# Waits until the libraries are really done: `want` libraries exist, none is scanning, and no job
# is pending or running, including the metadata, people, and scrub-thumbnail (trickplay) jobs a
# scan starts. The quiet must hold for three checks in a row, since a scan's follow-up jobs appear
# just as it finishes.
wait_libraries() {
  local want="$1" quiet=0 state_now
  for _ in $(seq 1 450); do
    state_now="$( { cli_raw libraries list; echo; cli_raw jobs list --limit 100; } 2>/dev/null | node -e '
      const [libraries, jobs] = require("node:fs").readFileSync(0, "utf8").split(/\n(?=\[)/).map((part) => JSON.parse(part));
      const failed = jobs.find((job) => job.kind === "scan" && job.status === "failed");
      if (failed) { console.log(`failed ${JSON.stringify(failed.error)}`); process.exit(0); }
      const active = jobs.filter((job) => job.status === "pending" || job.status === "running").length;
      const scanning = libraries.filter((library) => library.scanning).length;
      console.log(libraries.length >= Number(process.argv[1]) && active === 0 && scanning === 0 ? "done" : `busy ${active}`);' "$want")" ||
      state_now="busy"
    [[ "$state_now" == failed* ]] && die "a first scan ${state_now}; see \`logs --side $side\`"
    if [[ "$state_now" == done ]]; then
      (( ++quiet >= 3 )) && return 0
    else
      quiet=0
    fi
    sleep 2
  done
  die "the libraries were still busy after 15 minutes ($state_now)"
}

# ---------------------------------------------------------------------------------------------- up

cmd_up() {
  take_side "$@"
  local image="" library="" setup=1 seed=1 started=$SECONDS step=$SECONDS
  set -- "${args[@]}"
  while (($#)); do
    case "$1" in
      --image) image="$2"; shift 2 ;;
      --library) library="$2"; shift 2 ;;
      --no-setup) setup=0; seed=0; shift ;;
      --no-seed) seed=0; shift ;;
      *) die "up: unknown flag $1" ;;
    esac
  done
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] ||
    die "$project already exists; run \`down --side $side\` first"
  mkdir -p "$state" "$evidence"
  timing() { say "$1 took $((SECONDS - step))s"; step=$SECONDS; }

  local built=0
  if [[ -z "$image" && "$side" == before ]]; then
    image="$before_image_default"
    say "pulling $image"
    docker pull -q "$image" >/dev/null
  elif [[ -z "$image" ]]; then
    image="movies:verify-$run"
    say "building $image from $root"
    docker build -q -f "$root/deploy/compose/Dockerfile" --label "movies.verify.run=$run" \
      --label "movies.verify.rev=$(checkout_rev)" -t "$image" "$root" >/dev/null
    built=1
  fi
  write_state image "$image"
  write_state built "$built"
  write_state image_id "$(docker image inspect -f '{{.Id}}' "$image")"
  write_state rev "$(checkout_rev)"
  timing "the image"

  # The demo library is a data-only image that every side on this machine mounts read-only, so
  # Docker keeps one copy of it. Other libraries are folders bind-mounted read-only.
  local mount movies_dir="Movies" shows_dir="Shows"
  library="${library:-demo}"
  if [[ "$library" == demo ]]; then
    library="$demo_image"
    if ! docker image inspect "$library" >/dev/null 2>&1; then
      say "pulling $library (about 7 GB, once per machine)"
      docker pull -q "$library" >/dev/null ||
        die "could not pull $library; build it with scripts/build-demo-library.sh"
      timing "the demo library pull"
    fi
    mount=""
  else
    if [[ "$library" == fixtures ]]; then
      # Its own folder, never a state file's name: `library` holds the library's name below.
      library="$state/fixtures"
      rm -rf "$library"
      node "$root/apps/media/scripts/generate-fixtures.ts" "$library" >/dev/null
      chmod -R a+rX "$library"
    fi
    library="$(cd "$library" && pwd)"
    # The media service runs unprivileged in the container and must read every folder and file.
    if [[ -n "$(find "$library" \( \( -type d \! -perm -o+rx \) -o \( -type f \! -perm -o+r \) \) -print -quit)" ]]; then
      die "$library is not readable by others; run chmod -R a+rX on it"
    fi
    [[ -d "$library/Movies" ]] || movies_dir="movies"
    [[ -d "$library/Shows" ]] || shows_dir="shows"
    [[ -d "$library/$movies_dir" || -d "$library/$shows_dir" ]] ||
      die "$library has no Movies or Shows folder"
    mount="    volumes:
      - { type: bind, source: \"$library\", target: /media/library, read_only: true }"
  fi
  write_state library "$library"

  local port convex_port
  port="$(free_port)"
  convex_port="$(free_port)"
  write_state port "$port"
  write_state convex_port "$convex_port"
  # Both public URLs must be the addresses clients use: sign-in tokens and stream URLs carry them.
  # localhost works for the browser here and, through `ios up`'s ssh forwards, on the Mac.
  cat > "$state/compose.env" <<ENV
MOVIES_IMAGE=$image
MOVIES_BIND=127.0.0.1
MOVIES_PORT=$port
CONVEX_PORT=$convex_port
MOVIES_PUBLIC_URL=http://localhost:$port
CONVEX_PUBLIC_URL=http://localhost:$convex_port
MOVIES_LIBRARY=/nonexistent
PUID=$(id -u)
PGID=$(id -g)
TZ=UTC
ENV
  # Compose merges a service's volumes by their target, so either library mount replaces
  # compose.yaml's MOVIES_LIBRARY line.
  cat > "$state/compose.verify.yaml" <<YAML
services:
  convex:
    labels: { movies.verify.run: "$run", movies.verify.side: "$side" }
  movies:
    labels: { movies.verify.run: "$run", movies.verify.side: "$side" }
$mount
YAML
  compose up -d --pull missing --no-build --quiet-pull > "$state/compose.log" 2>&1 ||
    { cat "$state/compose.log" >&2; die "docker compose up failed"; }
  say "waiting for $project on ports $port (web) and $convex_port (Convex)"
  wait_healthy
  timing "starting the stack"

  [[ -f "$cli_js" ]] || pnpm --dir "$root" --filter @lmdevv/movies build >/dev/null
  start_browser
  if ((setup)); then
    local shows=()
    [[ "$library" == "$demo_image" || -d "$library/$shows_dir" ]] && shows=(--shows "/media/library/$shows_dir")
    say "running first-run setup through the web app and scanning the libraries"
    browser setup --movies "/media/library/$movies_dir" "${shows[@]}" >/dev/null
    as=lucia cli_login admin@movies.local
    cli_raw whoami | grep -q admin@movies.local || die "the CLI does not sign in as the owner"
    wait_libraries "$(( ${#shows[@]} > 0 ? 2 : 1 ))"
    write_state people lucia
    timing "setup and the first scans"
  fi
  if ((seed)); then
    [[ "$library" == "$demo_image" ]] || say "the seed expects the demo library's titles"
    say "seeding the demo people, profiles, access, and watching"
    seed
    timing "the seed"
  fi
  echo "ready: $(url) in $((SECONDS - started))s (run $run, side $side, project $project, image $image, library $library, evidence $evidence)"
}

seed() {
  node "$scripts/seed.mjs" --state "$state" --server "$(convex_url)" --media-url "$(url)" \
    --cli "$cli_js" --browser "$scripts/browser.mjs" >&2
}

# ------------------------------------------------------------------------------------------ doctor

cmd_doctor() {
  take_side "$@"
  local failed=0 port convex_port image_id
  check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; failed=1; fi; }
  port="$(read_state port)"
  convex_port="$(read_state convex_port)"
  image_id="$(read_state image_id)"
  [[ -n "$port" ]] || die "no $side side in run $run; run \`up --side $side\`"
  local m c
  m="$(container movies)"
  c="$(container convex)"
  check "containers $m and $c run" "[[ \$(docker inspect -f '{{.State.Running}}' $m $c | sort -u) == true ]]"
  check "both belong to run $run" "[[ \$(docker inspect -f '{{index .Config.Labels \"movies.verify.run\"}}' $m $c | sort -u) == $run ]]"
  check "port $port maps to $m" "docker port $m 8080/tcp | grep -q ':$port\$'"
  check "port $convex_port maps to $c" "docker port $c 3210/tcp | grep -q ':$convex_port\$'"
  check "/api/health reports the backend connected" "healthy"
  check "the media service runs the image from up" "[[ \$(docker inspect -f '{{.Image}}' $m) == $image_id ]]"
  check "the entrypoint deployed this image's functions" \
    "[[ \$(docker exec $m cat /data/version) == \$(docker exec $m sh -c 'echo \$(node -p \"require(\\\"/app/backend/package.json\\\").version\")+\$(cat /app/backend/.functions-hash)') ]]"
  check "browser host answers" "browser url"
  local network browser_pid browser_ns host_ns
  read -r network browser_pid <<<"$(browser network 2>/dev/null || true)"
  browser_ns="$( [[ -n "$browser_pid" ]] && readlink "/proc/$browser_pid/ns/net" 2>/dev/null || true)"
  host_ns="$(readlink /proc/self/ns/net 2>/dev/null || true)"
  case "$network" in
    isolated) check "the browser has its own network namespace" \
      "[[ -n '$browser_ns' && -n '$host_ns' && '$browser_ns' != '$host_ns' ]]" ;;
    host) echo "info  the browser shares the host network, where Docker network changes can fail its requests" ;;
    *) echo "FAIL  the browser host does not report its network"; failed=1 ;;
  esac
  if [[ -n "$(read_state people)" ]]; then
    check "the CLI signs in as the owner" "cli_raw whoami | grep -q admin@movies.local"
  else
    echo "skip  CLI (up ran with --no-setup)"
  fi
  if [[ "$(read_state built)" == 1 ]]; then
    if [[ "$(read_state rev)" == "$(checkout_rev)" ]]; then echo "ok    image matches the checkout"
    else echo "FAIL  the checkout changed since up; run \`down --side $side\` and \`up --side $side\` to test it"; failed=1; fi
  fi
  echo "info  version $(docker exec "$m" cat /data/version 2>/dev/null), image $(read_state image), library $(read_state library)"
  return "$failed"
}

# -------------------------------------------------------------------------------- browser, cli, logs

cmd_browser() {
  take_side "$@"
  [[ -S "$state/browser.sock" ]] || die "no browser host on the $side side; run \`up --side $side\`"
  if [[ "${args[0]:-}" == restart ]]; then
    local pid tries=0
    pid="$(read_state browser.pid)"
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
      (( ++tries <= 300 )) || die "the browser host $pid did not stop"
      sleep 0.1
    done
    start_browser
    if [[ -n "$(read_state people)" ]]; then
      browser sign-in --profile Lucía >/dev/null
      echo "browser host restarted; page main is signed in again as Lucía"
    else
      echo "browser host restarted"
    fi
    return
  fi
  browser "${args[@]}"
}

cmd_cli() {
  take_side "$@"
  set -- "${args[@]}"
  if [[ "${1:-}" == --as ]]; then
    # Before the slug: it works on bytes, so it would turn the í into two dashes.
    as="${2:?--as needs a person}"
    [[ "$as" == [Ll]ucía ]] && as=lucia
    as="$(slug "$as")"
    shift 2
  fi
  [[ "${1:-}" == "--" ]] && shift
  [[ -d "$state/cli/$as" ]] || {
    [[ "$as" == lucia ]] && die "no CLI session on the $side side; up ran with --no-setup"
    die "no CLI session for $as on the $side side; up ran with --no-seed, or $as is not a seeded person"
  }
  cli_raw "$@"
}

cmd_logs() {
  take_side "$@"
  local service=movies lines=80
  set -- "${args[@]}"
  while (($#)); do
    case "$1" in
      --service) service="$2"; shift 2 ;;
      *) lines="$1"; shift ;;
    esac
  done
  docker logs --tail "$lines" "$(container "$service")" 2>&1
}

cmd_status() {
  local s
  for s in after before; do
    take_side --side "$s"
    [[ -n "$(read_state port)" ]] || continue
    echo "$s: $(url) (Convex $(convex_url)) project $project ($(docker inspect -f '{{.State.Status}}' "$(container movies)" 2>/dev/null || echo gone)) image $(read_state image)"
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

# Prints the UI tree of the booted app as one "label = value | type #id | frame" line per element.
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
    # Not `ios_tree | grep -q`: grep stops at the first match, and with pipefail the tree's
    # writer failing on the closed pipe would fail the match.
    grep -qF -- "$label" <<<"$(ios_tree 2>/dev/null || true)" && return 0
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
    const roots = [].concat(JSON.parse(require("node:fs").readFileSync(0, "utf8")));
    for (const root of roots) walk(root);
    // A row that scrolls sideways lists its cards past the screen edge too; a tap there lands on
    // whatever is on screen at the clamped point, so only an element whose centre shows counts.
    const screen = roots[0]?.frame ?? { x: 0, y: 0, width: Infinity, height: Infinity };
    const centre = ({ frame: f }) => [f.x + f.width / 2, f.y + f.height / 2];
    const shown = found.filter((node) => {
      const [x, y] = centre(node);
      return x >= screen.x && x < screen.x + screen.width && y >= screen.y && y < screen.y + screen.height;
    });
    const rank = (node) => { const i = controls.indexOf(node.type ?? node.role ?? ""); return i < 0 ? 99 : i; };
    shown.sort((a, b) => rank(a) - rank(b));
    if (shown.length === 0) {
      console.error(found.length > 0 ? `"${label}" is off screen; swipe it into view` : `no element labeled "${label}" on screen`);
      process.exit(1);
    }
    const [x, y] = centre(shown[0]);
    console.log(`${Math.round(x)} ${Math.round(y)}`);' "$1"
}

# Taps a point, in points. A held touch, since AXe's instant tap misses some controls, such as the
# tab bar and a row swiped open; holding 0.15 s registers on every control as a finger does.
ios_touch() {
  on_mac "$axe touch -x $1 -y $2 --down --up --delay 0.15 --udid $(udid)" >/dev/null
}

ios_tap_label() {
  local point
  point="$(ios_find "$1")" || die "can't tap \"$1\"; run \`ios describe\`"
  ios_touch "${point% *}" "${point#* }"
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
      ios_touch "${point% *}" "${point#* }"
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

# The dev client, built on the Mac from this checkout: the checkout syncs to ~/movies-ios/verify-<run>
# there, `expo prebuild` runs only when the native inputs changed, and xcodebuild builds into
# ~/movies-ios/dd-verify-<run>. The app then moves to ~/movies-ios/dev-client-<hash>, named for the
# native inputs, and the derived data goes, so every run and worktree with the same inputs installs
# one build. JavaScript always comes from Metro.
native_hash() {
  (cd "${1:-$root}/apps/mobile" && (cat app.json package.json ../../pnpm-lock.yaml; find assets -type f | sort) | sha1sum | cut -d' ' -f1)
}

ios_build() {
  local id="$1" remote="$mac_dir/verify-$run"
  local app="$remote/apps/mobile"
  ssh "$mac" "mkdir -p $remote"
  rsync -az --delete --exclude node_modules --exclude /apps/mobile/ios --exclude .git --exclude dist \
    --exclude .expo --exclude .turbo --exclude /captures --exclude .repos "$root/" "$mac:$remote/"
  # No .git on the Mac, so the root prepare script (lefthook) can't run there.
  on_mac "cd $remote && pnpm install --frozen-lockfile --ignore-scripts >/dev/null"
  on_mac "cd $app && hash=\$( (cat app.json package.json ../../pnpm-lock.yaml; find assets -type f | sort) | shasum | cut -d' ' -f1) \
    && if [ ! -f ios/.native-hash ] || [ \"\$(cat ios/.native-hash)\" != \"\$hash\" ]; then \
         CI=1 npx expo prebuild -p ios --clean >/dev/null && echo \"\$hash\" > ios/.native-hash; fi"
  on_mac "cd $app/ios && xcodebuild -workspace movies.xcworkspace -scheme movies -configuration Debug \
      -sdk iphonesimulator -destination id=$id -derivedDataPath ~/$mac_dir/dd-verify-$run build -quiet"
  # Copy, then rename: two runs finishing the same build at once each leave a whole app.
  local shared="$mac_dir/dev-client-$(native_hash)"
  on_mac "rm -rf ~/$shared.tmp-$run && mkdir -p ~/$shared.tmp-$run \
    && cp -R ~/$mac_dir/dd-verify-$run/Build/Products/Debug-iphonesimulator/movies.app ~/$shared.tmp-$run/ \
    && { [ -d ~/$shared ] || mv ~/$shared.tmp-$run ~/$shared; } && rm -rf ~/$shared.tmp-$run ~/$mac_dir/dd-verify-$run"
}

cmd_ios_up() {
  local sim_type="iPhone 17 Pro" dark=1 source=""
  set -- "${args[@]:1}"
  while (($#)); do
    case "$1" in
      --device) sim_type="$2"; shift 2 ;;
      --source) source="$(cd "$2" && pwd)"; shift 2 ;;
      --light) dark=0; shift ;;
      *) die "ios up: unknown flag $1" ;;
    esac
  done
  [[ -n "$(read_state people)" ]] || die "start the $side side first: \`up --side $side\` (with setup)"
  [[ -z "$(read_state ios_udid)" ]] || die "the $side side already has a simulator; run \`ios down --side $side\`"
  on_mac "test -x $axe" || die "AXe is missing on $mac at ~/music-ios/tools/axe/axe; unpack the release from github.com/cameroncooke/AXe there"
  # The Mac's disk runs nearly full, and a full disk fails a build or a boot halfway with errors
  # that don't say why. A simulator needs about 2 GB; a first build also needs about 7 GB for the
  # synced checkout and its derived data.
  local app="\$HOME/$mac_dir/dev-client-$(native_hash)/movies.app" free need=3
  on_mac "test -d $app" || need=10
  free="$(on_mac "df -g \$HOME | awk 'NR == 2 { print \$4 }'")"
  ((free >= need)) || die "$mac has ${free} GB free and ios up needs ${need} GB; free space there (\`down --purge\` removes this run's checkout there and the dev client for its native inputs, which other runs with the same inputs share)"

  local port convex_port metro src
  port="$(read_state port)"
  convex_port="$(read_state convex_port)"
  metro="$(free_port)"
  write_state metro_port "$metro"
  # The simulator shares the Mac's network, so localhost:<port> on the Mac reaches this machine:
  # the web app and streams, Convex, and Metro.
  nohup ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -R "$port:127.0.0.1:$port" -R "$convex_port:127.0.0.1:$convex_port" -R "$metro:127.0.0.1:$metro" \
    "$mac" > "$state/forward.log" 2>&1 &
  write_state forward_pid "$!"
  sleep 2
  kill -0 "$(read_state forward_pid)" 2>/dev/null || { cat "$state/forward.log" >&2; die "the ssh forward to $mac failed"; }

  src="$root"
  [[ "$side" == before ]] && src="$(before_source)"
  if [[ -n "$source" ]]; then
    # The dev client is built from this checkout, so another checkout's JavaScript only runs on it
    # when both ask for the same native code.
    [[ "$(native_hash "$source")" == "$(native_hash)" ]] \
      || die "$source changes the app's native inputs; run verify-movies from that checkout instead"
    src="$source"
  fi
  say "starting Metro for $src on port $metro"
  # Not CI=1: that turns off file watching and the app keeps serving the first bundle.
  # Its own session, so `ios down` stops pnpm, Expo, and Metro's workers as one process group. The
  # log takes all its output, so nothing that reads this script's output waits on it.
  setsid bash -c 'cd "$1" && REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 exec pnpm --filter mobile exec \
    expo start --dev-client --port "$2"' metro "$src" "$metro" < /dev/null > "$state/metro.log" 2>&1 &
  write_state metro_pid "$!"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running || { tail -20 "$state/metro.log" >&2; die "Metro did not start"; }

  local id
  id="$(on_mac "xcrun simctl create movies-verify-$run-$side $(printf %q "$sim_type")")"
  write_state ios_udid "$id"
  write_state ios_device "$sim_type"
  on_mac "xcrun simctl boot $id && xcrun simctl bootstatus $id -b >/dev/null"
  ((dark)) && on_mac "xcrun simctl ui $id appearance dark"

  if ! on_mac "test -d $app"; then
    say "building the iOS dev client on $mac (minutes on a cold build)"
    ios_build "$id" >&2
  fi
  on_mac "xcrun simctl install $id $app"
  # Keep the dev client's own UI out of the evidence: no introduction over the app at first
  # launch, no floating button over the screens, and no gesture that opens its menu mid-recording.
  local key
  for key in IsOnboardingFinished:YES ShowsAtLaunch:NO ShowFloatingActionButton:NO \
    MotionGestureEnabled:NO TouchGestureEnabled:NO; do
    on_mac "xcrun simctl spawn $id defaults write dev.lmdevv.movies EXDevMenu${key%%:*} -bool ${key#*:}"
  done
  local metro_url
  metro_url="$(node -p 'encodeURIComponent(process.argv[1])' "http://127.0.0.1:$metro")"
  on_mac "xcrun simctl openurl $id 'exp+movies://expo-development-client/?url=$metro_url'"
  # iOS asks once whether to open the link in the app. Tap only that prompt's button.
  local tree
  for _ in $(seq 1 120); do
    tree="$(ios_tree 2>/dev/null || true)"
    grep -qE 'Connect to Server|Sign In' <<<"$tree" && break
    grep -q 'Open in' <<<"$tree" && ios_tap_label "Open" >/dev/null 2>&1
    sleep 2
  done

  say "connecting to $(url) and signing in"
  ios_sign_in
  echo "ready: ios $side on simulator $id (Metro $metro, server $(url))"
}

# A first password sign-in on a new simulator brings up iOS's own "Save Password?" sheet over the
# app. It isn't in the app's tree, so `ios_tree` can't see it, but AXe describes the element at a
# point. The sheet sits centred with "Not Now" on its left, on an iPhone as a wide sheet and on an
# iPad as a 300-point card, so look down the line 76 points left of centre, which crosses the
# button on both, and tap it. Only a top-level match counts: above the button, the point is on
# the sheet itself, whose children include the button. Returns 1 when no such sheet shows.
ios_dismiss_save_password() {
  local size
  size="$(ios_tree | sed -n '1s/.* \([0-9]*\)x\([0-9]*\)$/\1 \2/p')"
  [[ -n "$size" ]] || return 1
  on_mac "x=$(( ${size% *} / 2 - 76 )); for y in \$(seq $(( ${size#* } / 3 )) 12 $(( ${size#* } * 9 / 10 ))); do
      if $axe describe-ui --point \$x,\$y --udid $(udid) 2>/dev/null | grep -E '^  \"AXLabel\" : \"Not Now\"' >/dev/null; then
        $axe touch -x \$x -y \$y --down --up --delay 0.15 --udid $(udid) >/dev/null; exit 0; fi; done; exit 1"
}

ios_sign_in() {
  local tree
  tree="$(ios_tree)"
  local typed=0
  # Already signed in, on the profile picker: only the pick is left.
  if ! grep -q 'Manage Profiles' <<<"$tree"; then
    if ! grep -q 'Sign In with a Code' <<<"$tree"; then
      ios_tap_label "Connect to Server"
      ios_wait "Server address" 30
      ios_tap_label "Server address"
      ios_type "$(url)"
      ios_tap_label "Continue"
      ios_wait "Sign In with a Code" 60
    fi
    ios_tap_label "Email"
    ios_type "admin@movies.local"
    ios_tap_label "Password"
    ios_type "$password"
    ios_tap_label "Sign In"
    typed=1
  fi
  local tapped=0
  for _ in $(seq 1 60); do
    tree="$(ios_tree 2>/dev/null || true)"
    if grep -q "^ *Lucía" <<<"$tree" && grep -q 'Manage Profiles' <<<"$tree"; then
      # Still on the picker after a tap: the system's Save Password sheet took it.
      ((tapped)) && { ios_dismiss_save_password || true; }
      ios_tap_label "Lucía"
      tapped=1
    # A phone's tab bar is a Tab Bar; an iPad's sits at the top as a toolbar of radio buttons.
    elif grep -qE 'Tab Bar|^ *Home = 1 \| RadioButton' <<<"$tree"; then
      # After a password, the Save Password card can land after Home does, over the next screenshot.
      ((typed)) && { sleep 3; ios_dismiss_save_password || true; }
      return 0
    fi
    sleep 1
  done
  die "the app did not reach Home after signing in; run \`ios describe --side $side\`"
}

cmd_ios() {
  take_side "$@"
  local sub="${args[0]:-}"
  case "$sub" in
    up) cmd_ios_up ;;
    doctor)
      local failed=0 id
      id="$(udid)"
      kill -0 "$(read_state forward_pid)" 2>/dev/null && echo "ok    ssh forwards to $mac" || { echo "FAIL  ssh forwards to $mac"; failed=1; }
      curl -fsS "http://127.0.0.1:$(read_state metro_port)/status" 2>/dev/null | grep -q running && echo "ok    Metro on $(read_state metro_port)" || { echo "FAIL  Metro"; failed=1; }
      on_mac "xcrun simctl list devices | grep -F '$id) (Booted)' >/dev/null" && echo "ok    simulator $id booted" || { echo "FAIL  simulator $id"; failed=1; }
      on_mac "curl -fsS $(url)/api/health | grep -q connected" && echo "ok    the Mac reaches $(url)" || { echo "FAIL  the Mac reaches $(url)"; failed=1; }
      on_mac "curl -fsS $(convex_url)/version >/dev/null" && echo "ok    the Mac reaches Convex at $(convex_url)" || { echo "FAIL  the Mac reaches $(convex_url)"; failed=1; }
      return "$failed" ;;
    describe) ios_tree ;;
    sign-in) ios_sign_in && echo "signed in on $(udid)" ;;
    find) ios_find "${args[1]:?ios find <label>}" ;;
    tap)
      case "${args[1]:-}" in
        --label) ios_tap_label "${args[2]:?}" ;;
        --id) on_mac "$axe tap --id $(printf %q "${args[2]:?}") --udid $(udid)" ;;
        -x) ios_touch "${args[2]:?}" "${args[4]:?}" ;;
        *) die "ios tap --label L | --id ID | -x X -y Y" ;;
      esac ;;
    type) ios_type "${args[1]:?ios type <text>}" ;;
    swipe) on_mac "$axe swipe --start-x ${args[1]:?} --start-y ${args[2]:?} --end-x ${args[3]:?} --end-y ${args[4]:?} --duration 0.4 --udid $(udid)" ;;
    wait) ios_wait "${args[1]:?ios wait <label> [seconds]}" "${args[2]:-60}" ;;
    shot)
      local path="${args[1]:?ios shot <path.png>}"
      mkdir -p "$(dirname "$path")"
      on_mac "xcrun simctl io $(udid) screenshot --type=png /tmp/movies-verify-$run-$side.png >/dev/null 2>&1"
      scp -q "$mac:/tmp/movies-verify-$run-$side.png" "$path"
      echo "$path" ;;
    record)
      case "${args[1]:-}" in
        start)
          on_mac "rm -f /tmp/movies-verify-$run-$side.mp4; nohup xcrun simctl io $(udid) recordVideo --codec h264 --force /tmp/movies-verify-$run-$side.mp4 > /tmp/movies-verify-$run-$side.rec.log 2>&1 &"
          write_state ios_record "${args[2]:?ios record start <path.mp4>}"
          sleep 2 ;;
        stop)
          local out
          out="$(read_state ios_record)"
          [[ -n "$out" ]] || die "no recording in progress on the $side side"
          on_mac "pkill -INT -f 'recordVideo.*movies-verify-$run-$side.mp4' || true; sleep 3"
          mkdir -p "$(dirname "$out")"
          scp -q "$mac:/tmp/movies-verify-$run-$side.mp4" "$out"
          rm -f "$state/ios_record"
          echo "$out" ;;
        *) die "ios record start <path.mp4> | stop" ;;
      esac ;;
    appearance) on_mac "xcrun simctl ui $(udid) appearance ${args[1]:?ios appearance light|dark}" ;;
    orientation) ios_orientation "${args[1]:?ios orientation portrait|landscape}" ;;
    open) ios_open "${args[1]:?ios open <path>}" ;;
    matrix) ios_matrix "${args[@]:1}" ;;
    down) ios_down ;;
    *) die "ios: unknown command ${sub:-<none>}" ;;
  esac
}

# Runs an agent-device command in this side's session on the simulator. agent-device, which T3's
# device hub keeps on the Mac, acts within a session, and opening the running app in one only
# brings it forward. Its runner turns commands away while a slow capture finishes, so a failure gets
# two more tries a few seconds apart.
ios_agent() {
  local try
  for try in 1 2 3; do
    ios_agent_once "$@" && return 0
    ((try < 3)) && sleep 4
  done
  return 1
}

# One try, for a probe whose failure is an answer, such as no alert on screen.
ios_agent_once() {
  on_mac "ad=\$(ls -d ~/.t3/device/tools/agent-device@*/node_modules/.bin/agent-device | tail -1); session=movies-verify-$run-$side \
    && \$ad open dev.lmdevv.movies --udid $(udid) --platform ios --session \$session >/dev/null \
    && \$ad $* --session \$session"
}

# Turns the simulator, which simctl can't. The app's layout follows the window, so give it a moment.
ios_orientation() {
  local to="$1"
  [[ "$to" == landscape ]] && to=landscape-left
  [[ "$to" == portrait || "$to" == landscape-left ]] || die "ios orientation portrait|landscape"
  ios_turned "$to" && return 0
  ios_agent orientation "$to" >/dev/null
  sleep 2
  ios_turned "$to" || die "the simulator did not turn $1 (the app is $(ios_tree | sed -n '1s/.* //p'))"
}

ios_turned() {
  local size
  size="$(ios_tree | sed -n '1s/.* \([0-9]*\)x\([0-9]*\)$/\1 \2/p')"
  if [[ "$1" == portrait ]]; then ((${size% *} < ${size#* })); else ((${size% *} > ${size#* })); fi
}

# Opens an app path, such as /title/<id>, as a link to the app's own scheme. Expo Router routes it.
# iOS often asks "Open in [movies]?" first; agent-device reads the system's alert and accepts it.
ios_open() {
  on_mac "xcrun simctl openurl $(udid) $(printf %q "movies://$1")"
  local _
  for _ in 1 2 3 4; do
    ios_agent_once alert wait 3000 >/dev/null 2>&1 || return 0
    [[ "$(ios_alert)" == "Open in"* ]] || return 0
    ios_agent alert accept >/dev/null 2>&1 || true
    sleep 1
  done
}

# Prints the message of the iOS alert on screen, nothing when there is none, or `?` when
# agent-device could not tell.
ios_alert() {
  { ios_agent_once alert get --json 2>/dev/null || true; } | node -e '
    const replies = require("node:fs").readFileSync(0, "utf8").split(/\n(?=\{)/u);
    const reply = JSON.parse(replies.at(-1) || "{}");
    if (reply.success) console.log(reply.data.message);
    else if (reply.error?.details?.runnerErrorCode !== "ALERT_NOT_FOUND") console.log("?");' || echo "?"
}

# Screenshots each screen in ios_matrix_screens in each orientation, named
# <device>-<orientation>-<screen>.png, so two runs on the same devices compare file by file.
ios_matrix() {
  local out="" orientations="portrait landscape" only=""
  while (($#)); do
    case "$1" in
      --out) out="$2"; shift 2 ;;
      --orientations) orientations="${2//,/ }"; shift 2 ;;
      --screens) only=",$2,"; shift 2 ;;
      *) die "ios matrix --out DIR [--orientations portrait,landscape] [--screens a,b]" ;;
    esac
  done
  [[ -n "$out" ]] || die "ios matrix needs --out DIR"
  mkdir -p "$out"
  local device orientation screen name path screens alert
  device="$(slug "$(read_state ios_device)")"
  # Looked up here rather than in the list's subshell, where a failed lookup would go unnoticed.
  local movie show
  movie="$(title_id Sintel)" || die "no Sintel on the $side side for the matrix"
  show="$(title_id "Pioneer One")" || die "no Pioneer One on the $side side for the matrix"
  # Read up front: ssh in the loop would take the rest of the list as its input.
  mapfile -t screens < <(ios_matrix_screens "$movie" "$show")
  for orientation in $orientations; do
    ios_orientation "$orientation"
    for screen in "${screens[@]}"; do
      name="${screen%%|*}" path="${screen#*|}"
      [[ -z "$only" || "$only" == *",$name,"* ]] || continue
      ios_open "$path"
      sleep 4
      # A screenshot under a system prompt shows the prompt, not the screen, and passes for one.
      # agent-device also reports the app's own sheets, such as Seasons; iOS's prompts ask a
      # question ("Open in …?", "Save Password?") or for permission.
      alert="$(ios_alert)"
      [[ "$alert" != "?" ]] || say "could not check $name for an iOS prompt; look at it"
      [[ "$alert" == "?" || ! "$alert" =~ \?$|"Would Like" ]] || die "an iOS prompt covers $name: $alert"
      on_mac "xcrun simctl io $(udid) screenshot --type=png /tmp/movies-verify-$run-$side.png >/dev/null 2>&1"
      scp -q "$mac:/tmp/movies-verify-$run-$side.png" "$out/$device-$orientation-$name.png"
      echo "$out/$device-$orientation-$name.png"
    done
  done
  ios_orientation portrait
}

# The screens a layout change can reach, as name|path. Titles are looked up by name, since their
# ids differ on every side.
ios_matrix_screens() {
  local movie="$1" show="$2"
  cat <<SCREENS
home|/
movie|/title/$movie
show|/title/$show
seasons|/title/$show/seasons
about|/title/$movie/about
genre|/genre/Animation
my-list|/my-list
collections|/collections
search|/search
downloads|/downloads
you|/you
history|/history
settings|/settings
appearance|/settings/appearance
profiles|/switch-profile
manage-profiles|/manage-profiles
account|/account
owner|/owner
libraries|/owner/libraries
users|/owner/users
home-again|/
SCREENS
}

title_id() {
  "$0" cli --side "$side" -- search "$1" --limit 1 | node -e '
    const [title] = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (title === undefined) process.exit(1);
    console.log(title.id);'
}

ios_down() {
  local id pid
  id="$(read_state ios_udid)"
  if [[ -n "$id" ]]; then
    on_mac "pkill -INT -f 'recordVideo.*movies-verify-$run-$side' || true; xcrun simctl shutdown $id 2>/dev/null || true; xcrun simctl delete $id" || true
    on_mac "ad=\$(ls -d ~/.t3/device/tools/agent-device@*/node_modules/.bin/agent-device 2>/dev/null | tail -1); \
      [ -z \"\$ad\" ] || \$ad close --session movies-verify-$run-$side >/dev/null 2>&1 || true" || true
    # `ios shot` and `ios record` stage their files here before copying them back.
    on_mac "rm -f /tmp/movies-verify-$run-$side.png /tmp/movies-verify-$run-$side.mp4 /tmp/movies-verify-$run-$side.rec.log" || true
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
  rm -f "$state/ios_udid" "$state/ios_device" "$state/metro_pid" "$state/metro_port" "$state/forward_pid" "$state/ios_record"
}

# ----------------------------------------------------------------------------------------- evidence

cmd_evidence() {
  node "$scripts/evidence.mjs" "$@" --root "$root" --run "$run" --evidence "$evidence_root"
}

# --------------------------------------------------------------------------------------------- down

side_down() {
  take_side --side "$1"
  local label="label=com.docker.compose.project=$project" pid
  [[ -d "$state" || -n "$(docker ps -aq --filter "$label")$(docker volume ls -q --filter "$label")" ]] || return 0
  mkdir -p "$state"
  ios_down
  pid="$(read_state browser.pid)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  # The project's containers, network, and named volumes, and nothing else. Compose labels each
  # with the project's name, which also finds them when the state folder is gone.
  [[ -f "$state/compose.env" ]] && compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  docker ps -aq --filter "$label" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "$label" | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "$label" | xargs -r docker network rm >/dev/null 2>&1 || true
  # The after side's image is the one `up` built and labeled for this run.
  if [[ "$side" == after ]]; then
    docker images -q --filter "label=movies.verify.run=$run" | sort -u | xargs -r docker image rm -f >/dev/null 2>&1 || true
  fi
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
    on_mac "rm -rf ~/$mac_dir/verify-$run ~/$mac_dir/dd-verify-$run ~/$mac_dir/dev-client-$(native_hash)" || true
    say "removed the iOS build cache on $mac"
  fi
  [[ -z "$only" ]] && rmdir "$state_root" 2>/dev/null || true
}

# Bash reads a script as it runs, so an edit made during a long `up` or `ios up` would run whatever
# lands at the old offset. Reading all of main before any of it runs, then exiting, avoids that.
main() {
  local cmd="${1:-}"
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
    *) sed -n '2,16p' "$0" >&2; exit 2 ;;
  esac
}
main "$@"; exit
