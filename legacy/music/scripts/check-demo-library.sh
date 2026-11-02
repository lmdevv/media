#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"$root/deploy/demo-library/image")"
[[ "$image" =~ ^ghcr\.io/lmdevv/music-demo-library:v[1-9][0-9]*@sha256:[0-9a-f]{64}$ ]] ||
  { echo "expected a version and SHA-256 digest in deploy/demo-library/image" >&2; exit 1; }

docker pull "$image"
work="$(mktemp -d)"
container=""
cleanup() {
  local status=$?
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null || status=1
  fi
  rm -rf "$work" || status=1
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container="$(docker create "$image" /unused)"
docker cp "$container:/." "$work/"

mapfile -d '' mp3s < <(find "$work" -type f -name '*.mp3' -print0)
mapfile -d '' flacs < <(find "$work" -type f -name '*.flac' -print0)
[[ "${#mp3s[@]}" -eq 21 && "${#flacs[@]}" -eq 7 ]] ||
  { echo "expected 21 MP3 and 7 FLAC tracks, found ${#mp3s[@]} MP3 and ${#flacs[@]} FLAC" >&2; exit 1; }
for file in "${mp3s[@]}" "${flacs[@]}"; do
  [[ -r "$file" && -s "$file" ]] || { echo "empty or unreadable track: $file" >&2; exit 1; }
  [[ "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "$file")" == audio ]] ||
    { echo "no audio stream: $file" >&2; exit 1; }
done

mapfile -d '' covers < <(find "$work" -name cover.jpg -print0)
[[ "${#covers[@]}" -eq 5 ]] ||
  { echo "expected five cover.jpg files, found ${#covers[@]}" >&2; exit 1; }
for file in "${covers[@]}"; do
  resolved="$(realpath -e "$file")"
  [[ "$resolved" == "$work/"* && -f "$resolved" && -r "$resolved" && -s "$resolved" ]] ||
    { echo "empty, unreadable, or external cover: $file" >&2; exit 1; }
  [[ "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$resolved")" == mjpeg ]] ||
    { echo "invalid JPEG cover: $file" >&2; exit 1; }
done

[[ -r "$work/CREDITS.md" && -s "$work/CREDITS.md" ]] ||
  { echo "missing or empty CREDITS.md" >&2; exit 1; }
for license in by/3.0 by-sa/3.0 by/4.0; do
  grep -Fq "https://creativecommons.org/licenses/$license/" "$work/CREDITS.md" ||
    { echo "missing license URL in CREDITS.md: $license" >&2; exit 1; }
done
echo "validated $image: 28 audio tracks, five covers, and credits"
