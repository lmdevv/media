#!/usr/bin/env bash
# Maps a diff to the iOS apps CI bundles and the ones it builds natively, as GitHub step outputs.
#
#   scripts/ios-apps.sh --since <ref>  changes from the merge base of <ref> to HEAD
#   scripts/ios-apps.sh --all          every app
#   scripts/ios-apps.sh -              changed paths read from stdin, one per line
#
# It prints two lines, each a JSON list of app directory names under apps/mobile:
#
#   bundle=["movies","music"]  the apps scripts/changed-packages.sh reports for the diff
#   build=["music"]            those apps, counting only the paths that can change the native app
#
# A Debug simulator build skips the JavaScript bundle, so a path that only Metro reads cannot change
# what Xcode compiles or what `expo prebuild` generates. That is TypeScript, JavaScript, and CSS in
# a workspace package or in an app's src/, outside any ios/ or plugin/ folder, Markdown in any
# workspace, and the root files that only typecheck, lint and its plugins, format, test, turbo, and
# Nix read. Every other path counts, including Swift and podspecs anywhere, an app's other files
# outside src/, every package.json, the lockfile, the pnpm workspace file, patches, and CI.
#
# That holds only while every config plugin comes from an npm package: a plugin kept in this
# repository runs during prebuild and may import any JavaScript beside it, which no path rule can
# follow. So the script fails unless each app's config is an app.json whose plugins are all on the
# list below. A new plugin, or an app.config.* file, is added here once `native` counts the files
# it reads.
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
  case "$name" in package.json | app.json | app.config.* | app.plugin.* | react-native.config.* | expo-module.config.json)
    echo "$path"
    return
    ;;
  esac
  if [[ "$path" =~ ^(packages|apps/mobile)/ && "$name" == *.md ]]; then return; fi
  if [[ "$path" =~ ^packages/[^/]+/ || "$path" =~ ^apps/mobile/[^/]+/src/ ]]; then
    case "$name" in *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.css | *.snap | tsconfig*.json) return ;; esac
  fi
  case "$path" in
    tsconfig.json | vitest.config.ts | knip.json | oxlint.config.ts | .oxfmtrc.json | lefthook.yml) return ;;
    turbo.json | tools/oxlint/* | flake.nix | flake.lock | scripts/*.test.ts) return ;;
  esac
  echo "$path"
}

# The app names among changed-packages.sh's workspaces, as a JSON list.
apps() {
  local workspaces dir list=()
  # A command substitution does not inherit `set -e`, so a failed lookup is returned by hand.
  workspaces="$(scripts/changed-packages.sh "$@")" || return 1
  while IFS= read -r dir; do
    if [[ "$dir" == apps/mobile/* ]]; then list+=("\"${dir#apps/mobile/}\""); fi
  done < <(nonempty_lines "$workspaces")
  local IFS=,
  echo "[${list[*]}]"
}

# The config plugins an app may register. Each comes from an npm package, so its code changes only
# with the lockfile or a patch, and both count as native.
known_plugins="expo-audio expo-build-properties expo-camera expo-font expo-router expo-screen-orientation expo-secure-store expo-splash-screen expo-video"

# Prints each app config the script does not fully read, as `<file>: <reason>`. Anything it cannot
# read as plain JSON with an `expo` object counts, as Expo also takes JSON5, a config without that
# object, and an app.config file or folder, and each could register a plugin unseen.
unknown_config() {
  KNOWN="$known_plugins" node -e '
    const { readFileSync, readdirSync, statSync } = require("node:fs");
    const known = new Set(process.env.KNOWN.split(" "));
    const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    for (const app of readdirSync("apps/mobile")) {
      const dir = `apps/mobile/${app}`;
      if (!statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir);
      for (const file of files) {
        if (file === "app.config" || file.startsWith("app.config.")) {
          console.log(`${dir}/${file}: a dynamic config`);
        }
      }
      if (!files.includes("app.json")) continue;
      let config;
      try {
        config = JSON.parse(readFileSync(`${dir}/app.json`, "utf8"));
      } catch {
        console.log(`${dir}/app.json: not plain JSON`);
        continue;
      }
      if (!isObject(config) || !isObject(config.expo)) {
        console.log(`${dir}/app.json: no expo object`);
        continue;
      }
      const plugins = config.expo.plugins ?? [];
      if (!Array.isArray(plugins)) {
        console.log(`${dir}/app.json: plugins is not a list`);
        continue;
      }
      for (const plugin of plugins) {
        const name = Array.isArray(plugin) ? plugin[0] : plugin;
        if (typeof name !== "string" || !known.has(name)) {
          console.log(`${dir}/app.json: the plugin ${JSON.stringify(name)}`);
        }
      }
    }
  '
}

unknown="$(unknown_config)"
if [[ -n "$unknown" ]]; then
  echo "ios-apps.sh: an app config may run code from this repository during prebuild." >&2
  echo "Count the files it reads in native(), then teach this script to read it:" >&2
  echo "$unknown" >&2
  exit 1
fi

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
# Assigned before they are printed, so a failed lookup stops the script, not an empty list.
bundle="$(apps - <<<"$changed")"
build="$(apps - <<<"$built")"
echo "bundle=$bundle"
echo "build=$build"
