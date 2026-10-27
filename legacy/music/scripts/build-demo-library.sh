#!/usr/bin/env bash
# Builds the demo library image, tagged with the name in deploy/demo-library/image. A published
# version is never overwritten: change the files, then bump the version there.
#
#   scripts/build-demo-library.sh [--from DIR]   # build it into the local Docker
#   scripts/build-demo-library.sh --push         # build linux/amd64 and linux/arm64 and push it
#
# --from reuses a download of scripts/download-demo-music.sh instead of fetching it again.
# Needs Docker, curl, and ffmpeg.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"$root/deploy/demo-library/image")"
from="" push=0
while (($#)); do
  case "$1" in
    --from) from="$2"; shift 2 ;;
    --push) push=1; shift ;;
    *) echo "usage: $0 [--from DIR] [--push]" >&2; exit 2 ;;
  esac
done

# Push only when the registry says the tag doesn't exist. Any other failure, such as the registry
# being unreachable, stops here rather than risk replacing a published version.
if ((push)); then
  if found="$(docker buildx imagetools inspect "$image" 2>&1)"; then
    echo "$image is already published; bump the version in deploy/demo-library/image to change it"
    exit 0
  fi
  [[ "$found" == *": not found"* ]] || { echo "could not check $image: $found" >&2; exit 1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
[[ -n "$from" ]] && cp -a "$from/." "$work/"
"$root/scripts/download-demo-music.sh" "$work" >/dev/null
# The media service reads the files as an unprivileged user.
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
