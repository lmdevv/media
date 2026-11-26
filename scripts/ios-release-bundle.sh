#!/usr/bin/env bash
# Builds the JavaScript a Release build of one iOS app embeds, and its source map, from this
# checkout: `expo export:embed` with the arguments Xcode's "Bundle React Native code and images"
# phase passes (react-native-xcode.sh, Release, Hermes). It writes, into <out-dir>:
#
#   main.jsbundle      the JavaScript that hermesc then compiles into the app
#   main.jsbundle.map  its source map, back to the source files
#
# The build phase compiles main.jsbundle with `hermesc -O` and no source map, so the bytecode keeps
# hermesc's line table, and a stack frame of a release build names a line and column in this
# main.jsbundle. A frame an app reports (`Client.error`'s `frames`, `source: "bundle"`, in a batch
# with `bundle: "embedded"`) turns into a source file, line, and function with
# `scripts/symbolicate-app-frames.mjs main.jsbundle.map`. Build at the release's tag (`git checkout
# v0.9.0`, `pnpm install --frozen-lockfile`): the same commit and lockfile give the same bytes in any
# folder, which is what lets a map built later match the app.
#
#   scripts/ios-release-bundle.sh <movies|music> <out-dir>
set -euo pipefail

app="${1:-}"
out="${2:-}"
[[ ("$app" == movies || "$app" == music) && -n "$out" ]] \
  || { echo "usage: scripts/ios-release-bundle.sh <movies|music> <out-dir>" >&2; exit 2; }

mkdir -p "$out"
out="$(cd "$out" && pwd)"
cd "$(dirname "$0")/../apps/mobile/$app"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

expo_cli="$(node -p "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")"
entry="$(node -e "require('expo/scripts/resolveAppEntry')" "$PWD" ios absolute | tail -n 1)"

node "$expo_cli" export:embed \
  --entry-file "$entry" \
  --platform ios \
  --dev false \
  --reset-cache \
  --bundle-output "$out/main.jsbundle" \
  --assets-dest "$work/assets" \
  --minify false \
  --sourcemap-output "$out/main.jsbundle.map"

echo "$out/main.jsbundle $(wc -c < "$out/main.jsbundle" | tr -d ' ') bytes, map $out/main.jsbundle.map"
