#!/usr/bin/env bash
# Builds the demo library image, tagged with the name in deploy/demo-library/image, from the movies
# and music demo images that deploy/demo-library/Dockerfile pins by digest, then checks that it holds
# every title and album in docs/demo-library.md. A published version is never overwritten: change
# what goes in, then bump the version there.
#
#   scripts/build-demo-library.sh          # build it into the local Docker and check it
#   scripts/build-demo-library.sh --push   # also build linux/amd64 and linux/arm64 and push it
#
# Needs Docker and about 7.5 GB for the two source images.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(<"$root/deploy/demo-library/image")"
tag="${image%@*}"
dockerfile="$root/deploy/demo-library/Dockerfile"
push=0
while (($#)); do
  case "$1" in
    --push) push=1; shift ;;
    *) echo "usage: $0 [--push]" >&2; exit 2 ;;
  esac
done

# Push only when the registry says the tag doesn't exist. Any other failure, such as the registry
# being unreachable, stops here rather than risk replacing a published version.
if ((push)); then
  if found="$(docker buildx imagetools inspect "$tag" 2>&1)"; then
    echo "$tag is already published; bump the version in deploy/demo-library/image to change it"
    exit 0
  fi
  [[ "$found" == *": not found"* ]] || { echo "could not check $tag: $found" >&2; exit 1; }
fi

docker buildx build -q --load -t "$tag" - <"$dockerfile" >/dev/null

container="$(docker create "$tag" /unused)"
trap 'docker rm -f "$container" >/dev/null' EXIT
files="$(docker export "$container" | tar -t)"

problems=()
expect() { grep -qxF -- "$1" <<<"$files" || problems+=("missing $1"); }
count() { grep -c -- "$1" <<<"$files" || true; }
expect CREDITS.md
expect Music/CREDITS.md
for title in "Big Buck Bunny (2008)" "Elephants Dream (2006)" "Sintel (2010)" "Tears of Steel (2012)" \
  "Cosmos Laundromat - First Cycle (2015)" "[movies] Feature Test (2010)"; do
  expect "Movies/$title/movie.nfo"
  expect "Movies/$title/poster.jpg"
done
for show in "Caminandes (2013)" "Pioneer One (2010)"; do expect "Shows/$show/tvshow.nfo"; done
for album in "raymundo mendoza/translations ep" "Dadive/Frightening Freighters EP" \
  "Doc & Lena Selyanina/Cosmic Lullabies" "Doc & Lena Selyanina/Vienna Blue" "Andy G. Cohen/Prisma"; do
  expect "Music/$album/cover.jpg"
done
[[ "$(count '^Movies/\[movies\] Feature Test (2010)/[^/]*{edition-[^/]*}\.m[^/]*$')" -eq 4 ]] ||
  problems+=("the Feature Test needs its four editions")
[[ "$(count '^Shows/Caminandes (2013)/Season 01/[^/]*\.ogv$')" -eq 3 ]] ||
  problems+=("Caminandes needs 3 episodes")
[[ "$(count '^Shows/Pioneer One (2010)/Season 01/[^/]*\.mp4$')" -eq 6 ]] ||
  problems+=("Pioneer One needs 6 episodes")
[[ "$(count '^Music/.*\.mp3$')" -eq 21 && "$(count '^Music/.*\.flac$')" -eq 7 ]] ||
  problems+=("the music needs 21 MP3 and 7 FLAC tracks")
if ((${#problems[@]} > 0)); then
  printf '%s is not the full demo library:\n' "$tag" >&2
  printf '  %s\n' "${problems[@]}" >&2
  exit 1
fi

if ((push)); then
  docker buildx build --platform linux/amd64,linux/arm64 -t "$tag" --push - <"$dockerfile"
fi
echo "$tag"
