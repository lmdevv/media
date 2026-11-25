#!/usr/bin/env bash
# Maps a diff to the iOS apps CI bundles and the iOS apps it builds natively, as GitHub step outputs.
#
#   scripts/ios-apps.sh --since <ref>  changes from the merge base of <ref> to HEAD
#   scripts/ios-apps.sh --all          every app
#   scripts/ios-apps.sh -              changed paths read from stdin, one per line
#
# It prints two lines, each a JSON list of app directory names under apps/mobile:
#
#   bundle=["movies","music"]  the apps scripts/changed-packages.sh reports for the diff
#   build=["music"]            those apps again, counting only the paths that can change the native app
#
# A Debug simulator build skips the JavaScript bundle, so a path that only Metro reads cannot change
# what Xcode compiles or what `expo prebuild` generates. That is TypeScript, JavaScript, and CSS in a
# workspace package or in an app's src/, outside any ios/ or plugin/ folder, and the root files only
# typecheck, lint, format, test, and Nix read. Every other path counts, including Swift and podspecs
# anywhere, an app's files outside src/, every package.json, the lockfile, the pnpm workspace file,
# patches, and CI.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

usage() {
  echo "usage: scripts/ios-apps.sh --since <ref> | --all | -" >&2
  exit 2
}

nonempty_lines() { [[ -z "$1" ]] || printf '%s\n' "$1"; }

# Prints the path unless it can only change the JavaScript bundle.
native() {
  local path="$1" name="${1##*/}"
  case "/$path" in */ios/* | */plugin/*)
    echo "$path"
    return
    ;;
  esac
  case "$name" in package.json | app.json | app.config.* | app.plugin.js | react-native.config.js | expo-module.config.json)
    echo "$path"
    return
    ;;
  esac
  if [[ "$path" =~ ^packages/[^/]+/ || "$path" =~ ^apps/mobile/[^/]+/src/ ]]; then
    case "$name" in *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.css | *.md | *.snap | tsconfig*.json) return ;; esac
  fi
  case "$path" in
    tsconfig.json | vitest.config.ts | knip.json | oxlint.config.ts | .oxfmtrc.json | lefthook.yml) return ;;
    flake.nix | flake.lock | scripts/*.test.ts) return ;;
  esac
  echo "$path"
}

# The app names among changed-packages.sh's workspaces, as a JSON list.
apps() {
  local workspaces dir list=()
  workspaces="$(scripts/changed-packages.sh "$@")"
  while IFS= read -r dir; do
    if [[ "$dir" == apps/mobile/* ]]; then list+=("\"${dir#apps/mobile/}\""); fi
  done < <(nonempty_lines "$workspaces")
  local IFS=,
  echo "[${list[*]}]"
}

mode="${1:-}"
[[ $# -eq 0 ]] || shift
case "$mode" in
  --since)
    [[ $# -eq 1 ]] || usage
    changed="$(git diff --name-only --no-renames "$1...HEAD")"
    ;;
  --all)
    [[ $# -eq 0 ]] || usage
    every="$(apps --all)"
    echo "bundle=$every"
    echo "build=$every"
    exit 0
    ;;
  -)
    [[ $# -eq 0 ]] || usage
    changed="$(cat)"
    ;;
  *) usage ;;
esac

mapfile -t paths < <(nonempty_lines "$changed")
built="$(for path in "${paths[@]}"; do native "$path"; done)"
echo "bundle=$(apps - <<<"$changed")"
echo "build=$(apps - <<<"$built")"
