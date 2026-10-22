#!/usr/bin/env bash
# Builds the iOS app on a Mac over ssh, so the rest of the work can stay on Linux. JavaScript loads
# from Metro on this machine; only native changes need a rebuild.
#
#   scripts/ios-mac.sh sync                       # copy this checkout to the Mac and install deps
#   scripts/ios-mac.sh prebuild [--clean]         # generate ios/ and install pods when native inputs changed
#   scripts/ios-mac.sh build-sim <udid> [Release] # sync, prebuild, build (Debug), install on the simulator
#   scripts/ios-mac.sh open <udid> <metro-url>    # boot the simulator and open the dev client on Metro
#   scripts/ios-mac.sh remote <udid> <command>    # send play, pause, toggle, next, or previous
#   scripts/ios-mac.sh device [udid]              # sync, prebuild, build Release, install and launch on an iPhone
#
# MAC_HOST picks the ssh host (default darwin). The checkout lands in ~/music-ios/<name>, where
# <name> is MUSIC_IOS_NAME or the current branch, so worktrees don't overwrite each other.
# `device` signs with DEVELOPMENT_TEAM (default J9DZZ82K23) for the iPhone MUSIC_IOS_DEVICE
# (default 00008120-000919101102201E). codesign fails with errSecInternalComponent over ssh, so it
# builds in a Terminal window on the Mac and waits for that window's exit code.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
host="${MAC_HOST:-darwin}"
name="${MUSIC_IOS_NAME:-$(git -C "$root" rev-parse --abbrev-ref HEAD | tr '/' '-')}"
remote="music-ios/${name}"
app="${remote}/apps/mobile"

# Homebrew holds CocoaPods; a non-interactive ssh shell doesn't put it on PATH.
on_mac() {
  ssh "$host" "export PATH=/opt/homebrew/bin:\$PATH LANG=en_US.UTF-8; set -euo pipefail; $1"
}

sync() {
  ssh "$host" "mkdir -p ${remote}"
  rsync -az --delete \
    --exclude node_modules --exclude /apps/mobile/ios --exclude .git --exclude dist \
    --exclude .expo --exclude .turbo \
    "${root}/" "${host}:${remote}/"
  # No .git on the Mac, so the root prepare script (lefthook) can't run there.
  on_mac "cd ${remote} && pnpm install --frozen-lockfile --ignore-scripts"
}

# Regenerates ios/ only when the inputs that shape it change, unless --clean. A local module's
# file list counts, since pods pick up its sources when they install.
prebuild() {
  on_mac "cd ${app} && hash=\$( (cat app.json package.json ../../pnpm-lock.yaml assets/fonts/*.ttf assets/icon/*.png \
        assets/splash/*.png modules/*/expo-module.config.json modules/*/ios/*.podspec; find modules -type f | sort) \
      | shasum | cut -d' ' -f1) \
    && if [ '${1:-}' = --clean ] || [ ! -f ios/.native-hash ] || [ \"\$(cat ios/.native-hash)\" != \"\$hash\" ]; then \
         CI=1 npx expo prebuild -p ios --clean && echo \"\$hash\" > ios/.native-hash; \
       else echo 'ios/ is up to date'; fi"
}

build_sim() {
  local udid="$1" configuration="$2"
  sync
  prebuild
  on_mac "cd ${app}/ios && xcodebuild -workspace music.xcworkspace -scheme music -configuration ${configuration} \
      -sdk iphonesimulator -destination id=${udid} -derivedDataPath ~/music-ios/dd-${name} build -quiet \
    && (xcrun simctl boot ${udid} 2>/dev/null || true) \
    && xcrun simctl install ${udid} ~/music-ios/dd-${name}/Build/Products/${configuration}-iphonesimulator/music.app"
}

open_client() {
  local udid="$1" url
  url="$(node -p 'encodeURIComponent(process.argv[1])' "$2")"
  on_mac "(xcrun simctl boot ${udid} 2>/dev/null || true) \
    && xcrun simctl openurl ${udid} 'music://expo-development-client/?url=${url}'"
}

# What a lock screen, Control Center, or headphone press sends, delivered through the simulator's
# media remote service. See scripts/ios-remote-command.m.
remote_command() {
  local udid="$1" command="$2"
  ssh "$host" "mkdir -p music-ios/tools"
  rsync -a "${root}/scripts/ios-remote-command.m" "${host}:music-ios/tools/"
  on_mac "cd ~/music-ios/tools && ([ ios-remote-command -nt ios-remote-command.m ] \
      || xcrun -sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=17.0 -fobjc-arc \
        -framework Foundation ios-remote-command.m -o ios-remote-command) \
    && xcrun simctl spawn ${udid} \$HOME/music-ios/tools/ios-remote-command ${command}"
}

device() {
  local udid="$1" team="${DEVELOPMENT_TEAM:-J9DZZ82K23}" bundle exit_code
  bundle="$(node -p 'require(process.argv[1]).expo.ios.bundleIdentifier' "${root}/apps/mobile/app.json")"
  sync
  prebuild

  local derived="\$HOME/music-ios/dd-${name}-device" log="\$HOME/${remote}/device-build.log"
  ssh "$host" "rm -f ${remote}/device-build.exit && cat > ${remote}/build-device.sh" <<SCRIPT
export PATH=/opt/homebrew/bin:\$PATH LANG=en_US.UTF-8
cd \$HOME/${app}/ios
{
  xcodebuild -workspace music.xcworkspace -scheme music -configuration Release \\
      -destination id=${udid} -derivedDataPath ${derived} \\
      -allowProvisioningUpdates DEVELOPMENT_TEAM=${team} build -quiet \\
    && xcrun devicectl device install app --device ${udid} ${derived}/Build/Products/Release-iphoneos/music.app \\
    && xcrun devicectl device process launch --device ${udid} --terminate-existing ${bundle}
} > ${log} 2>&1
echo \$? > \$HOME/${remote}/device-build.exit
SCRIPT
  ssh "$host" "osascript -e 'tell application \"Terminal\" to do script \"zsh ~/${remote}/build-device.sh; exit\"'" >/dev/null
  echo "Building in a Terminal window on ${host}; the log is ~/${remote}/device-build.log there." >&2

  local deadline=$((SECONDS + 3600))
  until exit_code="$(ssh "$host" "cat ${remote}/device-build.exit 2>/dev/null")"; do
    if ((SECONDS > deadline)); then
      echo "No exit code after an hour; see ~/${remote}/device-build.log on ${host}." >&2
      return 1
    fi
    sleep 10
  done

  ssh "$host" "tail -n 20 ${remote}/device-build.log"
  return "$exit_code"
}

case "${1:-}" in
  sync) sync ;;
  prebuild) prebuild "${2:-}" ;;
  build-sim) build_sim "${2:?usage: build-sim <udid> [Release]}" "${3:-Debug}" ;;
  open) open_client "${2:?usage: open <udid> <metro-url>}" "${3:?usage: open <udid> <metro-url>}" ;;
  remote) remote_command "${2:?usage: remote <udid> <command>}" "${3:?usage: remote <udid> <command>}" ;;
  device) device "${2:-${MUSIC_IOS_DEVICE:-00008120-000919101102201E}}" ;;
  *)
    sed -n '2,16p' "$0" >&2
    exit 1
    ;;
esac
