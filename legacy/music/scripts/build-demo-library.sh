#!/usr/bin/env bash
# Builds a new demo library version. A published version is never overwritten.
#
#   scripts/build-demo-library.sh --version vN [--from DIR]   # build into local Docker
#   scripts/build-demo-library.sh --version vN --push         # publish amd64 and arm64
#
# --from reuses a download of scripts/download-demo-music.sh instead of fetching it again.
# Needs Docker, curl, and ffmpeg.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="" from="" push=0
while (($#)); do
  case "$1" in
    --version) version="${2:?--version requires vN}"; shift 2 ;;
    --from) from="${2:?--from requires a directory}"; shift 2 ;;
    --push) push=1; shift ;;
    *) echo "usage: $0 --version vN [--from DIR] [--push]" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^v[1-9][0-9]*$ ]] ||
  { echo "--version must be vN, where N is a positive integer" >&2; exit 2; }
image="ghcr.io/lmdevv/music-demo-library:$version"

if ((push)); then
  if found="$(docker buildx imagetools inspect "$image" 2>&1)"; then
    echo "$image is already published; choose a new --version" >&2
    exit 1
  fi
  [[ "$found" == *": not found"* ]] || { echo "could not check $image: $found" >&2; exit 1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[[ -n "$from" ]] && cp -a "$from/." "$work/"
"$root/scripts/download-demo-music.sh" "$work" >/dev/null
chmod -R a+rX "$work"
tracks="$(find "$work" -type f \( -name '*.mp3' -o -name '*.flac' \) | wc -l)"
[[ "$tracks" -eq 28 && -s "$work/CREDITS.md" ]] ||
  { echo "expected 28 tracks and CREDITS.md, found $tracks tracks" >&2; exit 1; }

if ((push)); then
  docker buildx build --platform linux/amd64,linux/arm64 -f "$root/deploy/demo-library/Dockerfile" \
    -t "$image" --push "$work"
else
  docker build -q -f "$root/deploy/demo-library/Dockerfile" -t "$image" "$work" >/dev/null
fi
echo "$image"
