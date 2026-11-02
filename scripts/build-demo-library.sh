#!/usr/bin/env bash
# Builds the demo library image, tagged with the name in deploy/demo-library/image, from the full
# set of scripts/demo-library.sh. A published version is never overwritten: change what goes in,
# then bump the version there.
#
#   scripts/build-demo-library.sh [--from DIR]   # build it into the local Docker
#   scripts/build-demo-library.sh --push         # build linux/amd64 and linux/arm64 and push it
#
# --from builds from a finished `scripts/demo-library.sh --set full --dir DIR` as it is, without
# downloading or changing anything in DIR. Without it, the script downloads the full set (about
# 7.5 GB with its cache) into a temporary folder and removes it afterwards. Needs Docker, and for
# the download curl, unzip, ffmpeg, dvdauthor, and fontconfig (`nix develop` has them all).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"$root/deploy/demo-library/image")"
from="" push=0
while (($#)); do
  case "$1" in
    --from) from="${2:?--from needs a folder}"; shift 2 ;;
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

if [[ -n "$from" ]]; then
  library="$(cd "$from" && pwd)"
else
  library="$(mktemp -d)"
  trap 'rm -rf "$library"' EXIT
  "$root/scripts/demo-library.sh" --dir "$library" --set full >&2
  # The library's videos are hard links into the cache, so this frees only what the image leaves
  # out: the Tears of Steel archive and the Feature Test's intermediate cuts.
  rm -rf "$library/.cache"
  chmod -R a+rX "$library"
fi

problems=()
expect() { [[ -e "$library/$1" ]] || problems+=("missing $1"); }
expect CREDITS.md
movies=("Big Buck Bunny (2008)" "Elephants Dream (2006)" "Sintel (2010)" "Tears of Steel (2012)"
  "Cosmos Laundromat - First Cycle (2015)" "[movies] Feature Test (2010)")
for title in "${movies[@]}"; do expect "Movies/$title/movie.nfo"; expect "Movies/$title/poster.jpg"; done
for show in "Caminandes (2013)" "Pioneer One (2010)"; do expect "Shows/$show/tvshow.nfo"; done
count() { find "$library/$1" -maxdepth 1 -type f -name "$2" 2>/dev/null | wc -l; }
[[ "$(count "Movies/[movies] Feature Test (2010)" '*{edition-*}.m*')" -eq 4 ]] ||
  problems+=("the Feature Test needs its four editions")
[[ "$(count "Shows/Caminandes (2013)/Season 01" '*.ogv')" -eq 3 ]] || problems+=("Caminandes needs 3 episodes")
[[ "$(count "Shows/Pioneer One (2010)/Season 01" '*.mp4')" -eq 6 ]] || problems+=("Pioneer One needs 6 episodes")
titles="$( (ls "$library/Movies"; ls "$library/Shows") 2>/dev/null | wc -l)"
[[ "$titles" -eq 8 ]] || problems+=("expected 6 movies and 2 shows, found $titles folders")
if command -v ffprobe >/dev/null; then
  ffprobe -v error -show_entries stream=codec_name -of csv=p=0 \
    "$library/Movies/[movies] Feature Test (2010)/[movies] Feature Test (2010) {edition-Multi-Audio and Subtitles}.mkv" \
    2>/dev/null | grep -q dvd_subtitle || problems+=("the Feature Test has no image subtitle (needs dvdauthor and fontconfig)")
fi
if [[ -n "$(find "$library/Movies" "$library/Shows" "$library/CREDITS.md" \( \( -type d \! -perm -o+rx \) -o \( -type f \! -perm -o+r \) \) -print -quit)" ]]; then
  problems+=("some files are not readable by others; run chmod -R a+rX on $library")
fi
if ((${#problems[@]} > 0)); then
  printf '%s is not the full demo library:\n' "$library" >&2
  printf '  %s\n' "${problems[@]}" >&2
  echo "run scripts/demo-library.sh --set full --dir $library to finish it" >&2
  exit 1
fi

if ((push)); then
  docker buildx build --platform linux/amd64,linux/arm64 -f "$root/deploy/demo-library/Dockerfile" \
    -t "$image" --push "$library"
else
  docker build -q -f "$root/deploy/demo-library/Dockerfile" -t "$image" "$library" >/dev/null
fi
echo "$image"
