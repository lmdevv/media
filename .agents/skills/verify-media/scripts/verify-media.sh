#!/usr/bin/env bash
# Runs disposable Lar stacks for verification and drives them. See ../SKILL.md.
#
#   verify-media.sh up [--side after|before] [--image IMG] [--library demo|fixtures|DIR] [--hardware none|qsv|vaapi] [--no-music] [--no-setup] [--no-seed]
#   verify-media.sh doctor [--side S]
#   verify-media.sh hardware [--side S] none|qsv|vaapi
#   verify-media.sh hardware-matrix [--side S] [--paths cpu,qsv,vaapi] [--rows ROW,...] [--grid-only]
#   verify-media.sh browser [--side S] [--app movies|music|account] <command> [flags]
#   verify-media.sh cli [--side S] [--as PERSON] -- <media args>
#   verify-media.sh logs [--side S] [lines]
#   verify-media.sh lyrics-probe [--side S]
#   verify-media.sh ios <up|doctor|describe|find|tap|type|swipe|wait|shot|record|appearance|orientation|open|matrix|offline|sign-in|down> [--side S] ...
#   verify-media.sh evidence <add|list|clear|publish> ...
#   verify-media.sh status
#   verify-media.sh down [--side S] [--purge]
#
# MEDIA_VERIFY_HEALTH_SECONDS bounds how long `up` waits for the stack to answer (default 360).
# MEDIA_VERIFY_RUN names the run (default: the checkout's directory name). A run has two sides:
# `after` is built from this checkout, `before` from main. Each side is its own Compose project,
# media-verify-<run>-<side>: that side's own revision of deploy/compose, the all-in-one image on one
# port, with the account client at /, the core's Convex at /convex, movies at /movies, and music at
# /music when the image holds it (music_core). Every person is a core user who signs in once at /.
set -euo pipefail

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$skill/../../.." && pwd)"
scripts="$skill/scripts"

slug() { tr '[:upper:]' '[:lower:]' <<<"$1" | tr -c 'a-z0-9\n' '-' | sed 's/^-*//; s/-*$//'; }
run="$(slug "${MEDIA_VERIFY_RUN:-$(basename "$root")}")"
[[ -n "$run" ]] || { echo "MEDIA_VERIFY_RUN is empty after cleaning" >&2; exit 2; }
state_root="${TMPDIR:-/tmp}/media-verify/$run"
evidence_root="$root/captures/verify/$run"
mac="${MAC_HOST:-darwin}"
axe='$HOME/media-ios/tools/axe/axe'
mac_dir="media-ios"
before_image_default="ghcr.io/lmdevv/media:main"
demo_image="$(<"$root/deploy/demo-library/image")"
cli_js="$root/apps/cli/dist/media.js"
password="password123"
health_seconds="${MEDIA_VERIFY_HEALTH_SECONDS:-360}"

die() { echo "verify-media: $*" >&2; exit 1; }
say() { echo "verify-media: $*" >&2; }

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
  project="media-verify-$run-$side"
}

read_state() { cat "$state/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" > "$state/$1"; }

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => {
    console.log(s.address().port); s.close(); });'
}

# The revision of what the image is built from: the checkout as committed, plus the contents of
# what changed since. The top-level paths that `.dockerignore` leaves out (such as .agents, .claude,
# docs, and nix) don't count, so a commit that only edits a skill or the docs keeps the revision and
# the after side stays current.
checkout_rev() {
  local ignored=() pattern meta path
  while read -r pattern; do
    [[ "$pattern" =~ ^[A-Za-z0-9._-]+$ ]] && ignored+=("$pattern")
  done < "$root/.dockerignore"
  local excludes=(":!captures")
  for path in "${ignored[@]}"; do excludes+=(":!$path"); done
  {
    git -C "$root" ls-tree HEAD | while IFS=$'\t' read -r meta path; do
      printf '%s\n' "${ignored[@]}" | grep -qxF -- "$path" || printf '%s\t%s\n' "$meta" "$path"
    done
    git -C "$root" diff HEAD -- . "${excludes[@]}"
    git -C "$root" ls-files -oz --exclude-standard -- . "${excludes[@]}" | (cd "$root" && xargs -0r sha1sum)
  } | sha1sum | cut -c1-12
}

chromium_path() {
  if [[ -n "${CHROMIUM_PATH:-}" ]]; then echo "$CHROMIUM_PATH"; return; fi
  # Playwright's bundled Chromium does not run on NixOS; its system Chromium does.
  if [[ -e /etc/NIXOS ]] && command -v chromium >/dev/null; then command -v chromium; fi
}

url() { echo "http://localhost:$(read_state port)"; }
movies_url() { echo "$(url)/movies"; }
# The core's Convex URL, which the CLI signs in to.
convex_url() { echo "$(url)/convex"; }
# The owner's username on the core.
owner="lucia"
# Music is the image's own client at /music (music_core), or not there at all: an image without
# the music client, the fixture library, or `up --no-music`.
music_core() { [[ "$(read_state music_core)" == 1 ]]; }
music_url() { echo "$(url)/music"; }
# Prints 1 when an image holds the music client (/app/music), which it serves at /music, and 0
# when it doesn't. A container with no network, so no host interface changes under a browser.
music_in() {
  local code=0
  timeout --kill-after=5 60 docker run --rm --network none --entrypoint test "$1" -d /app/music || code=$?
  case "$code" in
    0) echo 1 ;;
    1) echo 0 ;;
    *) die "could not look inside $1 for its music client (docker run exited $code)" ;;
  esac
}
container() { echo "$project-$1-1"; }

# Compose for this side only: its own project, the settings `up` wrote, the demo library's own
# override (deploy/compose/compose.demo.yaml, as self-hosters use it) or a bind mount of another
# library, the GPU override (compose.qsv.yaml or compose.vaapi.yaml) when the side runs on one, and
# an override that labels the containers. Settings in the caller's shell or in a
# deploy/compose/.env file would change what runs, so neither reaches Compose. A `docker_limit` of
# some seconds stops a call that takes longer, as when the Docker daemon stalls.
compose() {
  local unset=() name dir files hardware
  dir="$state/deploy/compose"
  files=(-f "$dir/compose.yaml")
  while read -r name; do unset+=(-u "$name"); done < <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$dir/.env.example")
  [[ "$(read_state library)" == "$demo_image" ]] && files+=(-f "$dir/compose.demo.yaml")
  hardware="$(read_state hardware)"
  if [[ "$hardware" == qsv || "$hardware" == vaapi ]]; then
    [[ -f "$dir/compose.$hardware.yaml" ]] || die "this side's deploy/compose has no compose.$hardware.yaml"
    files+=(-f "$dir/compose.$hardware.yaml")
  fi
  env "${unset[@]}" -u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES \
    ${docker_limit:+timeout --kill-after=5 "$docker_limit"} docker compose -p "$project" --env-file "$state/compose.env" "${files[@]}" -f "$state/compose.verify.yaml" "$@"
}

# Docker for a check or a cleanup on the way out, which a stalled daemon must not hold up: each call
# gets 15 seconds.
docker_brief() { timeout --kill-after=5 15 docker "$@"; }

# Health URLs that sent any HTTP response, so a wait that runs out can name the ones that never did.
declare -A answered=()

# Checks a health URL: succeeds when its body holds $2. Every request gives up within 10 seconds, so
# a stack the host cannot route to fails its wait instead of hanging it.
probe() {
  local body code=0
  body="$(curl -fsS --connect-timeout 5 --max-time 10 "$1" 2>/dev/null)" || code=$?
  # 22 is curl's code for an HTTP error status: the URL answered, but not with a success.
  ((code == 0 || code == 22)) && answered["$1"]=1
  ((code == 0)) && grep -qF -- "$2" <<<"$body"
}

health_url() { echo "$(url)/api/health"; }
healthy() { probe "$(health_url)" '"backend":"connected"'; }

stack_logs() {
  docker_limit=15 compose logs --no-color --tail 40 media >&2 ||
    say "could not read the containers' logs (status $?)"
}

# Removes a side that did not start, so a failed `up` leaves nothing running. The removal runs
# whatever its own steps do, and `up` still fails with the reason it stopped.
start_failed() {
  side_down "$side" >&2 || say "could not finish removing the $side side (status $?)"
  die "$1"
}

# Waits until the side reports its backend connected. On a stack that stops or never answers it
# prints why and calls $1: `start_failed` (the default) removes the side, as a failed `up` must.
wait_healthy() {
  local failed="${1:-start_failed}" status ip target service deadline=$((SECONDS + health_seconds))
  target="$(health_url)"
  service="$(container media)"
  while ((SECONDS < deadline)); do
    healthy && return 0
    status="$(docker_brief inspect -f '{{.State.Status}}' "$service" 2>/dev/null || echo missing)"
    if [[ "$status" == exited || "$status" == dead ]]; then
      stack_logs
      "$failed" "$service stopped while starting"
    fi
    sleep 2
  done
  stack_logs
  if [[ -n "${answered[$target]:-}" ]]; then say "$target answered but never reported ready"
  else say "$target never answered"; fi
  # Published ports reach a container through its address on a Docker network. A VPN route, such as
  # a Tailscale exit node's, can take that address away from the host.
  for ip in $(docker_brief inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$service" 2>/dev/null || true); do
    say "check the host's route to $service with \`ip route get $ip\`: $(ip route get "$ip" 2>/dev/null | head -1 || true)"
  done
  "$failed" "$project did not become healthy in ${health_seconds}s"
}

browser() {
  CHROMIUM_PATH="$(chromium_path)" ${cli_timeout:+timeout --kill-after=5 "$cli_timeout"} node "$scripts/browser.mjs" --state "$state" "$@"
}

# Starts the browser host. When it doesn't start, `up` removes the side (`start_failed`), and a
# restart on a running stack only fails (`die`): `$1` names which.
start_browser() {
  local failed="${1:-start_failed}"
  rm -f "$state/browser.sock"
  local music=()
  music_core && music=(--music "$(music_url)")
  # Its own session where setsid(1) exists, so a harness that stops the process group of the command
  # that ran `up` leaves the host running.
  local own_session=()
  command -v setsid >/dev/null && own_session=(setsid)
  CHROMIUM_PATH="$(chromium_path)" nohup "${own_session[@]}" node "$scripts/browser.mjs" serve --state "$state" \
    --base "$(movies_url)/" --account "$(url)" "${music[@]}" > "$state/browser.log" 2>&1 &
  write_state browser.pid "$!"
  for _ in $(seq 1 100); do
    if [[ -S "$state/browser.sock" ]]; then
      sed -n 's/^browser: /verify-media: /p' "$state/browser.log" >&2
      return 0
    fi
    kill -0 "$(read_state browser.pid)" 2>/dev/null || { cat "$state/browser.log" >&2; "$failed" "the browser host exited"; }
    sleep 0.2
  done
  cat "$state/browser.log" >&2
  "$failed" "the browser host did not start in 20s"
}

# Whether a pid is this side's browser host. A host that was killed leaves its pid on file, and the
# number may be another process's by now.
is_browser_host() {
  [[ -n "$1" ]] && ps -p "$1" -o args= 2>/dev/null | grep -qF "browser.mjs serve --state $state "
}

# Runs one step of `up`, such as signing in or seeding, within some seconds: `browser`, the CLIs,
# and the seeds read `cli_timeout` and run under timeout(1), which exits 124 when time runs out, as
# browser.mjs does when its host stays silent, or 137 when the step ignored the stop and was killed
# 5 seconds later. A step that runs out fails `up` the way a stack that never answered does.
within() {
  local seconds="$1" step="$2" code=0
  shift 2
  cli_timeout="$seconds" "$@" || code=$?
  ((code == 124 || code == 137)) && start_failed "$step did not finish in ${seconds}s"
  return "$code"
}

# The CLI for one person, with their own config folder, so sessions never mix. Lucía is the owner.
as="lucia"
cli_raw() {
  env -u MEDIA_SERVER_URL -u MEDIA_PROFILE -u MEDIA_PASSWORD -u MEDIA_CORE_URL -u MEDIA_CORE_SIGN_IN_URL \
    -u MEDIA_CORE_API_KEY -u MEDIA_CORE_ADMIN_KEY XDG_CONFIG_HOME="$state/cli/$as" ${cli_timeout:+timeout --kill-after=5 "$cli_timeout"} node "$cli_js" "$@"
}

# Signs a person's CLI in with their username and password, the way `media auth login` documents it.
cli_login() {
  mkdir -p "$state/cli/$as"
  printf %s "$password" | cli_raw auth login --server "$(convex_url)" --username "$1" >/dev/null
}

# Who a person's CLI is signed in as.
cli_whoami() { cli_raw auth sessions current; }

wait_libraries() {
  within 900 "the first scans" core_seed wait --cli "$cli_js" --container "$(container media)" --want "$1" ||
    start_failed "the first scans failed; see \`logs --side $side\`"
}

core_seed() {
  ${cli_timeout:+timeout --kill-after=5 "$cli_timeout"} node "$scripts/core-seed.mjs" "$1" --state "$state" "${@:2}"
}

# ---------------------------------------------------------------------------------------------- up

cmd_up() {
  take_side "$@"
  local image="" library="" hardware="" setup=1 seed=1 music=1 started=$SECONDS step=$SECONDS
  [[ "$health_seconds" =~ ^[1-9][0-9]*$ ]] || die "MEDIA_VERIFY_HEALTH_SECONDS must be a whole number of seconds"
  set -- "${args[@]}"
  while (($#)); do
    case "$1" in
      --image) image="$2"; shift 2 ;;
      --library) library="$2"; shift 2 ;;
      --hardware) hardware="$2"; shift 2 ;;
      --no-music) music=0; shift ;;
      --no-setup) setup=0; seed=0; shift ;;
      --no-seed) seed=0; shift ;;
      *) die "up: unknown flag $1" ;;
    esac
  done
  [[ -z "$hardware" ]] || hardware_usable "$hardware"
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" && ! -d "$state" ]] ||
    die "$project already exists; run \`down --side $side\` first"
  mkdir -p "$state" "$evidence"
  write_state up.pid "$$"
  timing() { say "$1 took $((SECONDS - step))s"; step=$SECONDS; }

  local built=0
  if [[ -z "$image" && "$side" == before ]]; then
    image="$before_image_default"
    say "pulling $image"
    docker pull -q "$image" >/dev/null
  elif [[ -z "$image" ]]; then
    image="media:verify-$run"
    say "building $image from $root"
    docker build -q -f "$root/deploy/image/Dockerfile" --label "media.verify.run=$run" \
      --label "media.verify.side=$side" --label "media.verify.rev=$(checkout_rev)" -t "$image" "$root" >/dev/null
    built=1
  fi
  # Each side runs its own revision's Compose files, so a change to the deploy shape still compares
  # against the shape main ships.
  mkdir -p "$state/deploy"
  if [[ "$side" == before ]]; then
    git -C "$root" fetch -q origin main || say "could not fetch main; using the local origin/main"
    git -C "$root" archive origin/main deploy/compose | tar -x -C "$state"
  else
    cp -R "$root/deploy/compose" "$state/deploy/compose"
  fi
  # An image that serves the music client at /music runs music too; one without it runs movies alone.
  # The probe's status is checked on its own: inside a condition errexit is off, so its `die` would
  # end only the substitution's subshell and a failed look would read as no music.
  local has_music=0
  if ((music)); then has_music="$(music_in "$image")" || exit $?; fi
  if ((music)) && [[ "$has_music" != 1 ]]; then
    say "$image has no music client, so this side runs movies alone"
    music=0
  fi
  write_state image "$image"
  write_state built "$built"
  write_state image_id "$(docker image inspect -f '{{.Id}}' "$image")"
  write_state rev "$(checkout_rev)"
  timing "the image"

  # The demo library is a data-only image that every side on this machine mounts read-only, so
  # Docker keeps one copy of it. Other libraries are folders bind-mounted read-only.
  local mount movies_dir="Movies" shows_dir="Shows" music_dir="Music"
  library="${library:-demo}"
  if [[ "$library" == demo ]]; then
    library="$demo_image"
    if ! docker image inspect "$library" >/dev/null 2>&1; then
      say "pulling $library (about 7.5 GB, once per machine)"
      docker pull -q "$library" >/dev/null || die "could not pull $library; check Docker and access to ghcr.io, then retry"
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
      # The fixtures hold films and shows only.
      ((music)) && say "the fixture library has no music, so this side runs movies alone"
      music=0
    fi
    library="$(cd "$library" && pwd)"
    # The media service runs unprivileged in its container and must read every folder and file.
    if [[ -n "$(find "$library" \( \( -type d \! -perm -o+rx \) -o \( -type f \! -perm -o+r \) \) -print -quit)" ]]; then
      die "$library is not readable by others; run chmod -R a+rX on it"
    fi
    [[ -d "$library/Movies" ]] || movies_dir="movies"
    [[ -d "$library/Shows" ]] || shows_dir="shows"
    [[ -d "$library/Music" ]] || music_dir="music"
    [[ -d "$library/$movies_dir" || -d "$library/$shows_dir" ]] ||
      die "$library has no Movies or Shows folder"
    ((music)) && [[ ! -d "$library/$music_dir" ]] && die "$library has no Music folder; add one or pass --no-music"
    mount="      - { type: bind, source: \"$library\", target: /media/library, read_only: true }"
  fi
  write_state library "$library"
  # Media the hardware matrix generates, which a side reads at /media/verify-fixtures.
  mkdir -p "$state/fixtures"
  if ((music)); then
    mkdir -p "$state/music"
    write_state music_core 1
  fi

  local port
  port="$(free_port)"
  write_state port "$port"
  # The public URL must be the address clients use: sign-in tokens and stream URLs carry it.
  # localhost works for the browser here and, through `ios up`'s ssh forwards, on the Mac.
  cat > "$state/compose.env" <<ENV
MEDIA_IMAGE=$image
MEDIA_BIND=127.0.0.1
MEDIA_PORT=$port
MEDIA_BASE_URL=http://localhost:$port
MEDIA_LIBRARY=/nonexistent
PUID=$(id -u)
PGID=$(id -g)
TZ=UTC
ENV
  [[ -z "$hardware" ]] || set_hardware "$hardware"
  # Compose merges a service's volumes by their target, so either library mount replaces
  # compose.yaml's MEDIA_LIBRARY line.
  cat > "$state/compose.verify.yaml" <<YAML
services:
  media:
    labels: { media.verify.run: "$run", media.verify.side: "$side" }
    volumes:
      - { type: bind, source: "$state/fixtures", target: /media/verify-fixtures, read_only: true }
$mount
YAML
  compose up -d --pull missing --no-build --quiet-pull > "$state/compose.log" 2>&1 ||
    { cat "$state/compose.log" >&2; die "docker compose up failed"; }
  say "waiting for $project on port $port"
  wait_healthy
  timing "starting the stack"

  # The after side's CLI is this checkout's, built fresh, so a change to it counts.
  if [[ "$side" == after || ! -f "$cli_js" ]]; then
    pnpm --dir "$root" --filter @lmdevv/media build > "$state/cli-build.log" 2>&1 ||
      { tail -20 "$state/cli-build.log" >&2; start_failed "could not build the media CLI"; }
  fi
  start_browser
  if ((setup)); then
    local shows=()
    [[ "$library" == "$demo_image" || -d "$library/$shows_dir" ]] && shows=(--shows "/media/library/$shows_dir")
    local music_folder=()
    music_core && music_folder=(--music-folder "/media/library/$music_dir")
    say "running first-run setup through the account client and scanning the libraries"
    within 1260 "first-run setup in the account client" \
      browser setup --movies "/media/library/$movies_dir" "${shows[@]}" "${music_folder[@]}" >/dev/null
    as=lucia within 60 "signing the owner's CLI in" cli_login "$owner"
    as=lucia within 60 "asking the owner's CLI who it is" cli_whoami > "$state/whoami.json"
    grep -q "$owner" "$state/whoami.json" || die "the CLI does not sign in as the owner"
    wait_libraries "$(( 1 + (${#shows[@]} > 0) + (${#music_folder[@]} > 0) ))"
    if music_core; then
      within 120 "signing the music page in" browser sign-in --app music >/dev/null
      write_state music/people lucia
    fi
    write_state people lucia
    timing "setup and the first scans"
  fi
  if ((seed)); then
    [[ "$library" == "$demo_image" ]] || say "the seed expects the demo library's titles and albums"
    say "seeding the demo people, the kid user, library grants, and watching on the core"
    within 900 "seeding movies" core_seed seed --server "$(convex_url)" --cli "$cli_js" --browser "$scripts/browser.mjs" >&2
    if music_core; then
      say "seeding music on the core: the Music library's grants, playlists, sharing, and likes"
      within 900 "seeding music" music_core_seed
    fi
    timing "the seed"
  fi
  write_state ready "$((SECONDS - started))"
  local music_note=""
  music_core && music_note=" music $(music_url),"
  echo "ready: $(url) in $((SECONDS - started))s (run $run, side $side, project $project, image $image,$music_note library $library, evidence $evidence)"
}

# Music's demo data on the core, through each person's own media CLI that the movies seed signed in.
music_core_seed() {
  ${cli_timeout:+timeout --kill-after=5 "$cli_timeout"} node "$scripts/music-core-seed.mjs" --state "$state" \
    --cli "$cli_js" >&2
}

# ------------------------------------------------------------------------------------------ doctor

cmd_doctor() {
  take_side "$@"
  local failed=0 port image_id
  check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; failed=1; fi; }
  port="$(read_state port)"
  image_id="$(read_state image_id)"
  [[ -n "$port" ]] || die "no $side side in run $run; run \`up --side $side\`"
  local m
  m="$(container media)"
  check "container $m runs" "[[ \$(docker inspect -f '{{.State.Running}}' $m) == true ]]"
  check "it belongs to run $run" "[[ \$(docker inspect -f '{{index .Config.Labels \"media.verify.run\"}}' $m) == $run ]]"
  check "port $port maps to $m" "docker port $m 8080/tcp | grep -q ':$port\$'"
  check "/api/health reports the backend connected" "healthy"
  check "the media service runs the image from up" "[[ \$(docker inspect -f '{{.Image}}' $m) == $image_id ]]"
  check "startup deployed this image's core functions" \
    "[[ \$(docker exec $m cat /data/core/version) == \$(docker exec $m sh -c 'echo \$(node -p \"require(\\\"/app/platform/package.json\\\").version\")+\$(cat /app/platform/.functions-hash)') ]]"
  check "browser host answers" "browser url"
  local network browser_pid browser_ns host_ns
  read -r network browser_pid <<<"$(browser network 2>/dev/null || true)"
  browser_ns="$( [[ -n "$browser_pid" ]] && readlink "/proc/$browser_pid/ns/net" 2>/dev/null || true)"
  host_ns="$(readlink /proc/self/ns/net 2>/dev/null || true)"
  case "$network" in
    isolated) check "the browser has its own network namespace" \
      "[[ -n '$browser_ns' && -n '$host_ns' && '$browser_ns' != '$host_ns' ]]" ;;
    host) echo "info  $(sed -n 's/^browser: //p' "$state/browser.log" | tail -1)" ;;
    *) echo "FAIL  the browser host does not report its network"; failed=1 ;;
  esac
  if [[ -n "$(read_state people)" ]]; then
    check "the CLI signs in as the owner" "cli_whoami | grep -qF '$owner'"
  else
    echo "skip  CLI (up ran with --no-setup)"
  fi
  if [[ "$(read_state built)" == 1 ]]; then
    if [[ "$(read_state rev)" == "$(checkout_rev)" ]]; then echo "ok    image matches the checkout"
    else echo "FAIL  the checkout changed since up; run \`down --side $side\` and \`up --side $side\` to test it"; failed=1; fi
  fi
  echo "info  version $(docker exec "$m" cat /data/core/version), image $(read_state image), library $(read_state library)"
  echo "info  HARDWARE_ACCELERATION=$(hardware_setting); the media service reports $(reported_hardware)"
  if music_core; then
    check "/music is the music client" "curl -fsS '$(music_url)/' | grep -qF '<title>Lar Music</title>'"
    echo "info  music is the image's client at $(music_url), on the core"
  else
    echo "info  no music (the image has no music client on the core, the library is the fixtures, or up ran with --no-music)"
  fi
  return "$failed"
}

# -------------------------------------------------------------------------------- browser, cli, logs

cmd_browser() {
  take_side "$@"
  [[ -n "$(read_state port)" ]] || die "no $side side in run $run; run \`up --side $side\`"
  if [[ "${args[0]:-}" == restart ]]; then
    local pid tries=0
    pid="$(read_state browser.pid)"
    if is_browser_host "$pid"; then
      kill "$pid" 2>/dev/null || true
      while is_browser_host "$pid"; do
        (( ++tries <= 300 )) || die "the browser host $pid did not stop"
        sleep 0.1
      done
    fi
    start_browser die
    if [[ -n "$(read_state people)" ]]; then
      browser sign-in >/dev/null
      [[ -n "$(read_state music/people)" ]] && browser sign-in --app music >/dev/null
      echo "browser host restarted; pages main$([[ -n "$(read_state music/people)" ]] && echo " and music") are signed in again as Lucía"
    else
      echo "browser host restarted"
    fi
    return
  fi
  [[ -S "$state/browser.sock" ]] || die "no browser host on the $side side; run \`browser restart --side $side\`"
  browser "${args[@]}"
}

cmd_cli() {
  take_side "$@"
  [[ -n "$(read_state port)" ]] || die "no $side side in run $run; run \`up --side $side\`"
  set -- "${args[@]}"
  while (($#)); do
    case "$1" in
      # Before the slug: it works on bytes, so it would turn the í into two dashes.
      --as) as="${2:?--as needs a person}"; [[ "$as" == [Ll]ucía ]] && as=lucia; as="$(slug "$as")"; shift 2 ;;
      --app)
        [[ "${2:-}" == movies ]] || die "cli runs the media CLI for both products: run \`cli -- music …\` for music"
        shift 2 ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  if [[ "${1:-} ${2:-}" == "auth login" ]]; then
    # A sign-in that fails leaves no config behind, so the next command still names the sign-in.
    local made=0 code=0
    [[ -d "$state/cli/$as" ]] || { mkdir -p "$state/cli/$as"; made=1; }
    cli_raw "$@" || code=$?
    ((code == 0 || made == 0)) || rm -rf "$state/cli/$as"
    return "$code"
  fi
  [[ -d "$state/cli/$as" ]] || {
    local login="cli${as:+ --as $as} -- auth login --server $(convex_url)"
    [[ "$as" == lucia ]] && die "no CLI session on the $side side; up ran with --no-setup. After the owner step, sign in with \`printf %s <password> | cli -- auth login --server $(convex_url) --username lucia\`"
    die "no CLI session for $as on the $side side; up ran with --no-seed, or $as is not a seeded person. \`$login\` prints a code to approve at /device and waits for it; with \`--username U\` or \`--api-key\` it reads the password or key from stdin"
  }
  cli_raw "$@"
}

cmd_logs() {
  take_side "$@"
  local lines="${args[0]:-80}"
  docker logs --tail "$lines" "$(container media)" 2>&1
}

# Makes a folder of songs with lyrics inside the side's container and prints its path, to add as a
# Music library: the demo library's songs have none. The songs are 40-second cuts of a demo song,
# one with a timed `.lrc` beside it and one with a plain `.txt`.
cmd_lyrics_probe() {
  take_side "$@"
  [[ -n "$(read_state port)" ]] || die "no $side side in run $run; run \`up --side $side\`"
  music_core || die "the $side side has no music"
  local dir=/media/lyrics-probe
  docker exec "$(container media)" sh -c '
    set -e
    album="$1/Verify Media/Lyrics Probe"
    source="$(find /media/library/Music -name "*.mp3" | sort | head -1)"
    [ -n "$source" ] || { echo "no demo song to cut from" >&2; exit 1; }
    mkdir -p "$album"
    cut() {
      ffmpeg -v error -y -i "$source" -t 40 -map 0:a -c copy -map_metadata -1 -metadata title="$2" \
        -metadata artist="Verify Media" -metadata album="Lyrics Probe" -metadata track="$1" "$album/0$1 $2.mp3"
    }
    cut 1 "Timed Probe"
    cut 2 "Plain Probe"
    printf "%s\n" "[00:00.00]First line" "[00:05.00]Second line" "[00:10.00]Third line" "[00:20.00]Fourth line" \
      > "$album/01 Timed Probe.lrc"
    printf "%s\n" "A plain first line" "A plain second line" > "$album/02 Plain Probe.txt"
    chmod -R a+rX "$1"' lyrics-probe "$dir" || die "could not make the lyrics folder in $(container media)"
  echo "$dir"
}

# ---------------------------------------------------------------------------------------- hardware

# HARDWARE_ACCELERATION as this side runs it: what `up --hardware` or `hardware` set, else the
# media service's default.
hardware_setting() {
  local setting
  setting="$(read_state hardware)"
  echo "${setting:-auto (unset)}"
}

# What /api/health says the media service encodes with: qsv, vaapi, or none.
reported_hardware() {
  curl -fsS --connect-timeout 5 --max-time 10 "$(health_url)" 2>/dev/null |
    node -e 'try { console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8")).hardwareAcceleration ?? "nothing") } catch { console.log("nothing (no answer)") }'
}

# Whether this host has a GPU render node. A plain glob, because the Nix dev shell's bash has no
# compgen.
has_render_node() {
  local node
  for node in /dev/dri/renderD*; do
    [[ -e $node ]] && return 0
  done
  return 1
}

# Fails unless this host can run a side with HARDWARE_ACCELERATION=$1: qsv and vaapi need a render
# node, which deploy/compose's override passes through as all of /dev/dri.
hardware_usable() {
  case "$1" in
    none) ;;
    qsv|vaapi) has_render_node || die "HARDWARE_ACCELERATION=$1 needs a render node (/dev/dri/renderD*) on this host" ;;
    *) die "HARDWARE_ACCELERATION is none, qsv, or vaapi, not ${1:-nothing}" ;;
  esac
}

# Records HARDWARE_ACCELERATION=$1 for the side: in compose.env, and in the state that makes
# `compose` add the GPU override.
set_hardware() {
  write_state hardware "$1"
  sed -i '/^HARDWARE_ACCELERATION=/d' "$state/compose.env"
  echo "HARDWARE_ACCELERATION=$1" >> "$state/compose.env"
}

# Moves a running side to HARDWARE_ACCELERATION=none, qsv, or vaapi. Compose recreates the one
# container with the same image, data, and port, so the side keeps its people and libraries; the
# browser host and the CLI sessions carry on. A side that does not come back is left as it is, for
# `logs`, then `down`.
cmd_hardware() {
  take_side "$@"
  [[ -n "$(read_state port)" ]] || die "no $side side in run $run; run \`up --side $side\`"
  local to="${args[0]:-}"
  hardware_usable "$to"
  if [[ "$(read_state hardware)" != "$to" ]]; then
    set_hardware "$to"
    docker_limit=300 compose up -d --no-build --quiet-pull > "$state/compose.log" 2>&1 ||
      { cat "$state/compose.log" >&2; die "docker compose up failed for HARDWARE_ACCELERATION=$to"; }
    say "waiting for $project with HARDWARE_ACCELERATION=$to"
    wait_healthy die
  fi
  echo "$side: HARDWARE_ACCELERATION=$to; the media service reports $(reported_hardware)"
}

# Measures which video stage works on which path and writes the grid under
# captures/verify/<run>/hardware-matrix/ (hardware-matrix.mjs holds the table). Each path moves the
# side to its setting first, so the side ends on the last path measured. `--grid-only` rewrites the
# grid from the cells on disk and needs no side.
cmd_hardware_matrix() {
  take_side "$@"
  if [[ " ${args[*]} " != *" --grid-only "* ]]; then
    [[ -n "$(read_state ready)" ]] || die "the $side side is not ready; run \`up --side $side\` first"
    [[ -n "$(read_state people)" ]] || die "the matrix plays as Lucía, whom up's setup makes; run \`up\` without --no-setup"
  fi
  node "$scripts/hardware-matrix-run.mjs" --helper "$scripts/verify-media.sh" --side "$side" --state "$state" \
    --container "$(container media)" --url "$(url)" --cli "$cli_js" --image "$(read_state image)" \
    --out "$evidence_root/hardware-matrix" --run "$run" --uid "$(id -u)" --gid "$(id -g)" "${args[@]}"
}

side_phase() {
  if [[ -n "$(read_state ready)" ]]; then echo ready
  elif kill -0 "$(read_state up.pid)" 2>/dev/null; then echo starting
  else echo failed; fi
}

cmd_status() {
  local s
  for s in after before; do
    take_side --side "$s"
    [[ -n "$(read_state port)" ]] || continue
    echo "$s: $(side_phase) movies $(movies_url) (Convex $(convex_url)) project $project ($(docker inspect -f '{{.State.Status}}' "$(container media)" 2>/dev/null || echo gone)) image $(read_state image), HARDWARE_ACCELERATION=$(hardware_setting)"
    music_core && echo "$s: $(side_phase) music $(music_url) on the image"
    [[ -n "$(read_state ios_udid)" ]] && echo "$s ios: simulator $(read_state ios_udid), metro $(read_state metro_port)"
  done
  echo "evidence: $evidence_root"
}

# --------------------------------------------------------------------------------------------- ios

on_mac() { ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 "$mac" "export PATH=/opt/homebrew/bin:\$PATH LANG=en_US.UTF-8; set -euo pipefail; $1"; }

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
  local label="$1" seconds="${2:-60}" deadline
  deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
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

# Which iOS app the `ios` commands build and open: `movies` (apps/mobile/movies, the default) or
# `music` (apps/mobile/music), as `ios up --app` picked it. Each is the Expo project, workspace,
# scheme, and app `<app>`, with the bundle identifier `dev.lmdevv.<app>`.
ios_app() {
  local app
  app="$(read_state ios_app)"
  echo "${app:-movies}"
}

# The dev client, built on the Mac from this checkout: the checkout syncs to ~/media-ios/verify-<run>
# there, `expo prebuild` runs only when the native inputs changed, and xcodebuild builds into
# ~/media-ios/dd-verify-<run>. The app then moves to ~/media-ios/dev-client-<hash>, named for the
# native inputs, and the derived data goes, so every run and worktree with the same inputs installs
# one build. JavaScript always comes from Metro.
native_inputs='cat app.json package.json ../../../pnpm-lock.yaml; if [ -d modules ]; then find assets modules -type f | sort; find modules -type f -print0 | sort -z | xargs -0 cat; else find assets -type f | sort; fi'

native_hash() {
  (cd "${1:-$root}/apps/mobile/${2:-$(ios_app)}" && eval "$native_inputs" | sha1sum | cut -d' ' -f1)
}

ios_build() {
  local id="$1" name remote="$mac_dir/verify-$run"
  name="$(ios_app)"
  local app="$remote/apps/mobile/$name"
  ssh "$mac" "mkdir -p $remote"
  # Both apps' prebuilt native projects stay: a build of one app must not delete the other's.
  rsync -az --delete --exclude node_modules --exclude "/apps/mobile/*/ios" --exclude .git --exclude dist \
    --exclude .expo --exclude .turbo --exclude /captures --exclude .repos "$root/" "$mac:$remote/"
  # No .git on the Mac, so the root prepare script (lefthook) can't run there.
  on_mac "cd $remote && pnpm install --frozen-lockfile --ignore-scripts >/dev/null"
  on_mac "cd $app && hash=\$( ($native_inputs) | shasum | cut -d' ' -f1) \
    && if [ ! -f ios/.native-hash ] || [ \"\$(cat ios/.native-hash)\" != \"\$hash\" ]; then \
         CI=1 npx expo prebuild -p ios --clean >/dev/null && echo \"\$hash\" > ios/.native-hash; fi"
  on_mac "cd $app/ios && xcodebuild -workspace $name.xcworkspace -scheme $name -configuration Debug \
      -sdk iphonesimulator -destination id=$id -derivedDataPath ~/$mac_dir/dd-verify-$run build -quiet"
  # Copy, then rename: two runs finishing the same build at once each leave a whole app.
  local shared="$mac_dir/dev-client-$(native_hash)"
  on_mac "rm -rf ~/$shared.tmp-$run && mkdir -p ~/$shared.tmp-$run \
    && cp -R ~/$mac_dir/dd-verify-$run/Build/Products/Debug-iphonesimulator/$name.app ~/$shared.tmp-$run/ \
    && { [ -d ~/$shared ] || mv ~/$shared.tmp-$run ~/$shared; } && rm -rf ~/$shared.tmp-$run ~/$mac_dir/dd-verify-$run"
}

# The Mac's network is the simulator's, so a port forwarded there makes localhost:<port> on the Mac
# reach this machine. Metro and the server (the web clients, Convex, and streams on Lar's one port)
# each get an ssh of their own, so the server's can stop while the app keeps its code.
forward_settle="${MEDIA_VERIFY_FORWARD_SETTLE:-2}"

# Whether the pid on file under $1 is still a forward this side started.
forward_runs() {
  local pid
  pid="$(read_state "$1")"
  [[ -n "$pid" ]] && ps -p "$pid" -o args= 2>/dev/null | grep -qF "ssh -N"
}

# Forwards port $2 and records the ssh under $1. The Mac may still hold the port for a forward that
# just stopped, so a forward it refuses is tried again.
forward_start() {
  local try
  for try in 1 2 3 4 5; do
    nohup ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R "$2:127.0.0.1:$2" \
      "$mac" > "$state/$1.log" 2>&1 &
    write_state "$1" "$!"
    sleep "$forward_settle"
    forward_runs "$1" && return 0
  done
  cat "$state/$1.log" >&2
  die "the ssh forward of port $2 to $mac failed"
}

forward_stop() {
  local pid tries=0
  forward_runs "$1" || return 0
  pid="$(read_state "$1")"
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    (( ++tries <= 100 )) || die "the ssh forward $pid did not stop"
    sleep 0.1
  done
}

# Brings up whichever forward is not running: both after `ios up`, and either one that died.
forwards_up() {
  forward_runs forward_pid || forward_start forward_pid "$(read_state metro_port)"
  forward_runs server_forward_pid || forward_start server_forward_pid "$(read_state port)"
  rm -f "$state/ios_offline"
}

cmd_ios_up() {
  local sim_type="iPhone 17 Pro" dark=1 source="" name=movies given="" sign_in=1
  set -- "${args[@]:1}"
  while (($#)); do
    case "$1" in
      --device) sim_type="$2"; shift 2 ;;
      --source) source="$(cd "$2" && pwd)"; shift 2 ;;
      --light) dark=0; shift ;;
      --app) name="$2"; shift 2 ;;
      --udid) given="$2"; shift 2 ;;
      --no-sign-in) sign_in=0; shift ;;
      *) die "ios up: unknown flag $1" ;;
    esac
  done
  [[ "$name" == movies || "$name" == music ]] || die "ios up --app must be movies or music, not $name"
  [[ "$name" == movies || "$(read_state music_core)" == 1 ]] \
    || die "the music iOS app signs in to the core's music, which the $side side's image does not serve; run it against an image with the music client (music_core)"
  [[ -n "$(read_state people)" ]] || die "start the $side side first: \`up --side $side\` (with setup)"
  [[ -z "$(read_state ios_udid)" ]] || die "the $side side already has a simulator; run \`ios down --side $side\`"
  ((sign_in == 0)) || on_mac "test -x $axe" || die "AXe is missing on $mac at ~/media-ios/tools/axe/axe; unpack the release from github.com/cameroncooke/AXe there"
  write_state ios_app "$name"
  # The Mac's disk runs nearly full, and a full disk fails a build or a boot halfway with errors
  # that don't say why. A simulator needs about 2 GB; a first build also needs about 7 GB for the
  # synced checkout and its derived data.
  local app="\$HOME/$mac_dir/dev-client-$(native_hash)/$name.app" free need=3
  on_mac "test -d $app" || need=10
  free="$(on_mac "df -g \$HOME | awk 'NR == 2 { print \$4 }'")"
  ((free >= need)) || die "$mac has ${free} GB free and ios up needs ${need} GB; free space there (\`down --purge\` removes this run's checkout there and the dev client for its native inputs, which other runs with the same inputs share)"

  local port metro src
  port="$(read_state port)"
  metro="$(free_port)"
  write_state metro_port "$metro"
  forwards_up

  src="$root"
  [[ "$side" == before ]] && src="$(before_source)"
  if [[ -n "$source" ]]; then
    # The dev client is built from this checkout, so another checkout's JavaScript only runs on it
    # when both ask for the same native code.
    [[ "$(native_hash "$source")" == "$(native_hash)" ]] \
      || die "$source changes the app's native inputs; run verify-media from that checkout instead"
    src="$source"
  fi
  say "starting Metro for $src on port $metro"
  # Not CI=1: that turns off file watching and the app keeps serving the first bundle.
  # Its own session, so `ios down` stops pnpm, Expo, and Metro's workers as one process group. The
  # log takes all its output, so nothing that reads this script's output waits on it.
  setsid bash -c 'cd "$1" && REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 exec pnpm --filter "@media/mobile-$3" exec \
    expo start --dev-client --port "$2"' metro "$src" "$metro" "$name" < /dev/null > "$state/metro.log" 2>&1 &
  write_state metro_pid "$!"
  for _ in $(seq 1 120); do
    curl -fsS --max-time 5 "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running && break
    sleep 1
  done
  curl -fsS --max-time 5 "http://127.0.0.1:$metro/status" 2>/dev/null | grep -q running || { tail -20 "$state/metro.log" >&2; die "Metro did not start"; }

  local id
  if [[ -n "$given" ]]; then
    # A simulator someone else keeps, such as one T3's device tools opened: the side installs and
    # runs the app on it, and `ios down` leaves the simulator itself alone.
    id="$given"
    sim_type="$(on_mac "xcrun simctl list devices | grep -F '($id)' | sed 's/^ *//; s/ (.*//'")"
    write_state ios_udid "$id"
    write_state ios_owned 0
    write_state ios_device "$sim_type"
    on_mac "xcrun simctl bootstatus $id -b >/dev/null"
  else
    id="$(on_mac "xcrun simctl create media-verify-$run-$side $(printf %q "$sim_type")")"
    write_state ios_udid "$id"
    write_state ios_device "$sim_type"
    on_mac "xcrun simctl boot $id && xcrun simctl bootstatus $id -b >/dev/null"
    ((dark)) && on_mac "xcrun simctl ui $id appearance dark"
  fi

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
    on_mac "xcrun simctl spawn $id defaults write dev.lmdevv.$name EXDevMenu${key%%:*} -bool ${key#*:}"
  done
  local metro_url
  metro_url="$(node -p 'encodeURIComponent(process.argv[1])' "http://127.0.0.1:$metro")"
  if ((sign_in == 0)); then
    # Whoever drives the simulator opens the app on Metro and signs in, such as with T3's device
    # tools' agent-device `open dev.lmdevv.<app> --url <this>`.
    echo "ready: ios $side $name on simulator $id (Metro $metro, server $(url)); open exp+$name://expo-development-client/?url=$metro_url"
    return 0
  fi
  on_mac "xcrun simctl openurl $id 'exp+$name://expo-development-client/?url=$metro_url'"
  # iOS asks once whether to open the link in the app. Tap only that prompt's button.
  local tree deadline=$((SECONDS + 240))
  while ((SECONDS < deadline)); do
    tree="$(ios_tree 2>/dev/null || true)"
    grep -qE 'Connect to Server|Connect to your server|Sign In|Sign in' <<<"$tree" && break
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

# Signs in as the seeded person $1 (the owner, lucia, by default) with their username and password.
# Switching person is signing out first.
ios_sign_in() {
  local who="${1:-$owner}" tree
  tree="$(ios_tree)"
  [[ "$(ios_app)" == music ]] && { ios_sign_in_music "$who"; return; }
  if ! grep -q 'Sign In with a Code' <<<"$tree"; then
    ios_tap_label "Connect to Server"
    ios_wait "Server address" 30
    ios_tap_label "Server address"
    ios_type "$(url)"
    ios_tap_label "Continue"
    ios_wait "Sign In with a Code" 60
  fi
  ios_tap_label "Username"
  ios_type "$who"
  ios_tap_label "Password"
  ios_type "$password"
  ios_tap_label "Sign In"
  for _ in $(seq 1 60); do
    tree="$(ios_tree 2>/dev/null || true)"
    # A phone's tab bar is a Tab Bar; an iPad's sits at the top as a toolbar of radio buttons.
    if grep -qE 'Tab Bar|^ *Home = 1 \| RadioButton' <<<"$tree"; then
      # After a password, the Save Password card can land after Home does, over the next screenshot.
      sleep 3
      ios_dismiss_save_password || true
      return 0
    fi
    sleep 1
  done
  die "the app did not reach Home after signing in; run \`ios describe --side $side\`"
}

# On a phone whose other Lar app signed in, the music app opens signed in without asking.
ios_sign_in_music() {
  local who="$1" tree
  tree="$(ios_tree)"
  if grep -q 'Connect to your server' <<<"$tree"; then
    ios_tap_label "Connect to your server"
    ios_wait "Server address" 30
    ios_tap_label "Server address"
    ios_type "$(url)"
    ios_tap_label "Connect"
  fi
  for _ in $(seq 1 60); do
    tree="$(ios_tree 2>/dev/null || true)"
    grep -qE 'Tab Bar|^ *Home = 1 \| RadioButton' <<<"$tree" && return 0
    grep -q '^ *Username' <<<"$tree" && break
    sleep 1
  done
  ios_tap_label "Username"
  ios_type "$who"
  ios_tap_label "Password"
  ios_type "$password"
  ios_tap_label "Sign in"
  for _ in $(seq 1 60); do
    tree="$(ios_tree 2>/dev/null || true)"
    if grep -qE 'Tab Bar|^ *Home = 1 \| RadioButton' <<<"$tree"; then
      sleep 3
      ios_dismiss_save_password || true
      return 0
    fi
    sleep 1
  done
  die "the music app did not reach Home after signing in; run \`ios describe --side $side\`"
}

cmd_ios() {
  take_side "$@"
  local sub="${args[0]:-}"
  case "$sub" in
    up) cmd_ios_up ;;
    doctor)
      local failed=0 id
      id="$(udid)"
      local offline=0
      [[ -n "$(read_state ios_offline)" ]] && offline=1
      if forward_runs forward_pid && { ((offline)) || forward_runs server_forward_pid; }; then echo "ok    ssh forwards to $mac"
      else echo "FAIL  ssh forwards to $mac; \`ios offline off\` starts them again"; failed=1; fi
      curl -fsS --max-time 5 "http://127.0.0.1:$(read_state metro_port)/status" 2>/dev/null | grep -q running && echo "ok    Metro on $(read_state metro_port)" || { echo "FAIL  Metro"; failed=1; }
      on_mac "xcrun simctl list devices | grep -F '$id) (Booted)' >/dev/null" && echo "ok    simulator $id booted" || { echo "FAIL  simulator $id"; failed=1; }
      if ((offline)); then
        echo "info  the server is cut off from the Mac (\`ios offline on\`); \`ios offline off\` brings it back"
        return "$failed"
      fi
      on_mac "curl -fsS --max-time 10 $(url)/api/health | grep -q connected" && echo "ok    the Mac reaches $(url)" || { echo "FAIL  the Mac reaches $(url)"; failed=1; }
      on_mac "curl -fsS --max-time 10 $(convex_url)/version >/dev/null" && echo "ok    the Mac reaches Convex at $(convex_url)" || { echo "FAIL  the Mac reaches $(convex_url)"; failed=1; }
      return "$failed" ;;
    offline)
      udid >/dev/null
      case "${args[1]:-}" in
        on) forward_stop server_forward_pid; write_state ios_offline 1; echo "the app's server is out of reach" ;;
        off) forwards_up; echo "the app reaches its server again" ;;
        *) die "ios offline on|off" ;;
      esac ;;
    describe) ios_tree ;;
    sign-in)
      local who=""
      [[ "${args[1]:-}" == --as ]] && who="${args[2]:?ios sign-in --as <person>}"
      ios_sign_in "$who" && echo "signed in on $(udid)" ;;
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
      on_mac "xcrun simctl io $(udid) screenshot --type=png /tmp/media-verify-$run-$side.png >/dev/null 2>&1"
      scp -q "$mac:/tmp/media-verify-$run-$side.png" "$path"
      echo "$path" ;;
    record)
      case "${args[1]:-}" in
        start)
          on_mac "rm -f /tmp/media-verify-$run-$side.mp4; nohup xcrun simctl io $(udid) recordVideo --codec h264 --force /tmp/media-verify-$run-$side.mp4 > /tmp/media-verify-$run-$side.rec.log 2>&1 &"
          write_state ios_record "${args[2]:?ios record start <path.mp4>}"
          sleep 2 ;;
        stop)
          local out
          out="$(read_state ios_record)"
          [[ -n "$out" ]] || die "no recording in progress on the $side side"
          on_mac "pkill -INT -f 'recordVideo.*media-verify-$run-$side.mp4' || true; sleep 3"
          mkdir -p "$(dirname "$out")"
          scp -q "$mac:/tmp/media-verify-$run-$side.mp4" "$out"
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
  on_mac "ad=\$(ls -d ~/.t3/device/tools/agent-device@*/node_modules/.bin/agent-device | tail -1); session=media-verify-$run-$side \
    && \$ad open dev.lmdevv.$(ios_app) --udid $(udid) --platform ios --session \$session >/dev/null \
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

# iOS often asks "Open in Lar Movies?" first; agent-device reads the system's alert and accepts it.
ios_open() {
  on_mac "xcrun simctl openurl $(udid) $(printf %q "$(ios_app)://$1")"
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
  [[ "$(ios_app)" == movies ]] || die "ios matrix lists the movies app's screens, and the $side side runs the $(ios_app) app"
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
      on_mac "xcrun simctl io $(udid) screenshot --type=png /tmp/media-verify-$run-$side.png >/dev/null 2>&1"
      scp -q "$mac:/tmp/media-verify-$run-$side.png" "$out/$device-$orientation-$name.png"
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
account|/account
owner|/owner
libraries|/owner/libraries
users|/owner/users
home-again|/
SCREENS
}

title_id() {
  (cmd_cli --side "$side" -- movies titles search --query "$1") | node -e '
    const titles = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const title = titles.find((found) => found.name === process.argv[1]);
    if (title === undefined) process.exit(1);
    console.log(title.id);' "$1"
}

ios_down() {
  local id pid
  id="$(read_state ios_udid)"
  if [[ -n "$id" ]]; then
    on_mac "pkill -INT -f 'recordVideo.*media-verify-$run-$side' || true" || true
    # A simulator `ios up --udid` borrowed stays, with the app on it.
    [[ "$(read_state ios_owned)" == 0 ]] || on_mac "xcrun simctl shutdown $id 2>/dev/null || true; xcrun simctl delete $id" || true
    on_mac "ad=\$(ls -d ~/.t3/device/tools/agent-device@*/node_modules/.bin/agent-device 2>/dev/null | tail -1); \
      [ -z \"\$ad\" ] || \$ad close --session media-verify-$run-$side >/dev/null 2>&1 || true" || true
    # `ios shot` and `ios record` stage their files here before copying them back.
    on_mac "rm -f /tmp/media-verify-$run-$side.png /tmp/media-verify-$run-$side.mp4 /tmp/media-verify-$run-$side.rec.log" || true
  fi
  # Metro leads its own process group; pnpm ignores SIGTERM, so the group gets SIGKILL after it.
  pid="$(read_state metro_pid)"
  if [[ -n "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  forward_stop forward_pid
  forward_stop server_forward_pid
  rm -f "$state/ios_udid" "$state/ios_device" "$state/ios_owned" "$state/ios_app" "$state/metro_pid" \
    "$state/metro_port" "$state/forward_pid" "$state/server_forward_pid" "$state/forward_pid.log" \
    "$state/server_forward_pid.log" "$state/ios_offline" "$state/ios_record"
}

# ----------------------------------------------------------------------------------------- evidence

cmd_evidence() {
  node "$scripts/evidence.mjs" "$@" --root "$root" --run "$run" --evidence "$evidence_root"
}

# --------------------------------------------------------------------------------------------- down

side_down() {
  take_side --side "$1"
  local label="label=com.docker.compose.project=$project" pid
  [[ -d "$state" || -n "$(docker_brief ps -aq --filter "$label")$(docker_brief volume ls -q --filter "$label")" ]] || return 0
  mkdir -p "$state"
  ios_down
  pid="$(read_state browser.pid)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  # The project's containers, network, and named volumes, and nothing else. Compose labels each
  # with the project's name, which also finds them when the state folder is gone.
  # Each step is bounded, and one that fails or runs out leaves the rest to run.
  if [[ -f "$state/compose.env" ]] && ! docker_limit=60 compose down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1; then
    say "compose down did not finish for $project; check \`docker ps -a --filter $label\`"
  fi
  docker_brief ps -aq --filter "$label" | xargs -r timeout --kill-after=5 15 docker rm -f >/dev/null 2>&1 || true
  docker_brief volume ls -q --filter "$label" | xargs -r timeout --kill-after=5 15 docker volume rm >/dev/null 2>&1 || true
  docker_brief network ls -q --filter "$label" | xargs -r timeout --kill-after=5 15 docker network rm >/dev/null 2>&1 || true
  docker_brief images -q --filter "label=media.verify.run=$run" --filter "label=media.verify.side=$side" | sort -u |
    xargs -r timeout --kill-after=5 15 docker image rm -f >/dev/null 2>&1 || true
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
    on_mac "rm -rf ~/$mac_dir/verify-$run ~/$mac_dir/dd-verify-$run ~/$mac_dir/dev-client-$(native_hash "$root" movies) \
      ~/$mac_dir/dev-client-$(native_hash "$root" music)" || true
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
    lyrics-probe) cmd_lyrics_probe "$@" ;;
    hardware) cmd_hardware "$@" ;;
    hardware-matrix) cmd_hardware_matrix "$@" ;;
    ios) cmd_ios "$@" ;;
    evidence) cmd_evidence "$@" ;;
    status) cmd_status ;;
    down) cmd_down "$@" ;;
    *) sed -n '2,20p' "$0" >&2; exit 2 ;;
  esac
}
# Tests source the script to call its functions; run as a command, it runs main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; exit; fi
