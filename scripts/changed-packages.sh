#!/usr/bin/env bash
# Maps a diff to the workspaces it affects, and runs typecheck, lint, or test on just those.
#
#   scripts/changed-packages.sh --staged [task]       the staged changes
#   scripts/changed-packages.sh --since <ref> [task]  changes from the merge base of <ref> to HEAD
#   scripts/changed-packages.sh --all [task]          every workspace
#   scripts/changed-packages.sh - [task]              changed paths read from stdin, one per line
#
# With no task it prints each affected workspace directory on its own line: `.` for the root
# workspace, then its packages, then legacy/music. A change inside a package affects that package
# and every package that depends on it. A change to the root workspace affects every package.
#
# With a task it runs `pnpm <task>` over the affected packages of the root workspace, over the whole
# workspace when `.` is affected, or not at all. It never runs a task over legacy/music. Arguments
# after `test` go to Vitest, such as `--project playback`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

usage() {
  echo "usage: scripts/changed-packages.sh --staged | --since <ref> | --all | - [typecheck | lint | test [vitest arguments]]" >&2
  exit 2
}

nonempty_lines() { [[ -z "$1" ]] || printf '%s\n' "$1"; }

# turbo prints its version on stderr, so stderr is shown only when it fails.
turbo_dirs() {
  local json
  if ! json="$(node_modules/.bin/turbo ls "$@" --output=json 2>/dev/null)"; then
    node_modules/.bin/turbo ls "$@" >&2
    exit 1
  fi
  node -e 'for (const p of JSON.parse(process.argv[1]).packages.items) console.log(p.path);' "$json"
}

route() {
  local path="$1" dir
  for dir in "${packages[@]}"; do
    if [[ "$path" == "$dir"/* ]]; then
      echo "$dir"
      return
    fi
  done
  case "$path" in
    legacy/*) echo legacy/music ;;
    .github/workflows/ci.yml | .github/actions/*) printf '%s\n' . legacy/music ;;
    scripts/changed-packages.sh) echo . ;;
    nix/* | scripts/check-sandbox.sh) echo apps/media ;;
    scripts/dev-stack.sh | deploy/convex-backend.image) printf '%s\n' packages/backend packages/platform ;;
    deploy/functions-hash.sh) echo packages/backend ;;
    scripts/check-version.sh) echo apps/cli ;;
    docs/* | *.md | LICENSE | .env.example | .gitignore | .dockerignore | deploy/* | scripts/*.sh) ;;
    .github/* | .agents/* | .claude/* | skills-lock.json) ;;
    *) echo . ;;
  esac
}

mode="${1:-}"
[[ $# -eq 0 ]] || shift
if [[ "$mode" == --since ]]; then
  [[ $# -gt 0 ]] || usage
  since="$1"
  shift
fi
task="${1:-}"
[[ $# -eq 0 ]] || shift
extra=("$@")
case "$task" in "" | typecheck | lint) ((${#extra[@]} == 0)) || usage ;; test) ;; *) usage ;; esac

# Command substitutions, not process substitutions, so a failing git or turbo stops the script
# instead of reading as an empty diff.
case "$mode" in
  --staged) changed="$(git diff --cached --name-only --no-renames)" ;;
  --since) changed="$(git diff --name-only --no-renames "$since...HEAD")" ;;
  --all) changed="" ;;
  -) changed="$(cat)" ;;
  *) usage ;;
esac
listed="$(turbo_dirs)"
mapfile -t packages < <(nonempty_lines "$listed" | sort)

if [[ "$mode" == --all ]]; then
  routed=(. legacy/music)
else
  mapfile -t paths < <(nonempty_lines "$changed")
  mapfile -t routed < <(for path in "${paths[@]}"; do route "$path"; done | sort -u)
fi

whole=false legacy=false filters=()
for dir in "${routed[@]}"; do
  case "$dir" in
    .) whole=true ;;
    legacy/music) legacy=true ;;
    *) filters+=("--filter=...{./$dir}") ;;
  esac
done

if $whole; then
  affected=("${packages[@]}")
elif ((${#filters[@]} > 0)); then
  dependents="$(turbo_dirs "${filters[@]}")"
  mapfile -t affected < <(nonempty_lines "$dependents" | sort)
else
  affected=()
fi

if [[ -z "$task" ]]; then
  if $whole; then echo .; fi
  if ((${#affected[@]} > 0)); then printf '%s\n' "${affected[@]}"; fi
  if $legacy; then echo legacy/music; fi
elif $whole; then
  exec pnpm "$task" "${extra[@]}"
elif ((${#affected[@]} == 0)); then
  echo "$task: skipped, no package changed"
else
  echo "$task: ${affected[*]}"
  case "$task" in
    typecheck) exec node_modules/.bin/turbo run typecheck "${affected[@]/#/--filter=./}" ;;
    lint) exec pnpm lint "${affected[@]}" ;;
    test) exec pnpm test "${affected[@]/%//}" "${extra[@]}" ;;
  esac
fi
