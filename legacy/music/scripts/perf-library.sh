#!/usr/bin/env bash
# Builds a large synthetic library for measuring scans and queries: by default 20,000 tagged
# tracks in 1,500 albums by 400 artists, half FLAC and half MP3, each a fraction of a second long
# so the whole library stays under 300 MB. Every album folder has its own tiny cover.jpg. The
# output is the same on every run, so before and after measurements read the same data.
#
#   scripts/perf-library.sh generate [dir] [tracks] [albums] [artists]   # default ./perf-library
#   scripts/perf-library.sh mutate [dir] [count]                          # retitle `count` tracks
#
# `mutate` retags the first `count` tracks of the library (100 by default) with a new title, so a
# rescan reads and stores exactly those files. Run it again for another change.
# Needs bash, ffmpeg, and xargs. Uses every core.
set -euo pipefail

mode="${1:-generate}"
dir="${2:-./perf-library}"
jobs="$(nproc 2>/dev/null || echo 4)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One short source per format, re-muxed with each track's tags: copying the stream is far cheaper
# than encoding 20,000 files.
make_sources() {
  ffmpeg -v error -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.5" \
    -ac 2 -c:a flac "$work/source.flac"
  ffmpeg -v error -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.5" \
    -ac 2 -c:a libmp3lame -b:a 128k "$work/source.mp3"
}

# Writes one track: tab-separated source, target, title, artist, album, track number, year, genre.
write_track() {
  local source="$1" target="$2" title="$3" artist="$4" album="$5" number="$6" year="$7" genre="$8"
  ffmpeg -v error -y -i "$source" -map 0:a -c copy \
    -metadata title="$title" -metadata artist="$artist" -metadata album_artist="$artist" \
    -metadata album="$album" -metadata track="$number" -metadata date="$year" \
    -metadata genre="$genre" "$target.part.${target##*.}"
  mv -- "$target.part.${target##*.}" "$target"
}
export -f write_track

# Gives one existing file a new title, keeping its audio, pictures, and other tags.
retitle_track() {
  local target="$1" title="$2"
  ffmpeg -v error -y -i "$target" -map 0 -c copy -metadata title="$title" \
    "$target.part.${target##*.}"
  mv -- "$target.part.${target##*.}" "$target"
}
export -f retitle_track

generate() {
  local tracks="${1:-20000}" albums="${2:-1500}" artists="${3:-400}"
  local started genres album artist count first format year genre folder number title
  started="$(date +%s%N)"
  genres=(Rock Jazz Electronic Classical Folk Hip-Hop Ambient Pop)
  mkdir -p "$dir"
  make_sources

  : >"$work/tracks.tsv"
  : >"$work/covers.tsv"
  for ((album = 0; album < albums; album++)); do
    artist=$((album % artists))
    # Spread the tracks evenly: the first `tracks % albums` albums get one more.
    count=$((tracks / albums + (album < tracks % albums ? 1 : 0)))
    format=$([[ $((album % 2)) == 0 ]] && echo flac || echo mp3)
    year=$((1960 + album % 60))
    genre="${genres[$((album % ${#genres[@]}))]}"
    folder="$dir/Artist $(printf %03d "$artist")/Album $(printf %04d "$album")"
    mkdir -p "$folder"
    [[ -s "$folder/cover.jpg" ]] || printf '%s\t%s\n' "$album" "$folder/cover.jpg" >>"$work/covers.tsv"
    for ((number = 1; number <= count; number++)); do
      title="Song $(printf %02d "$number") of Album $(printf %04d "$album")"
      first="$folder/$(printf %02d "$number") - Song.$format"
      [[ -s "$first" ]] && continue
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$work/source.$format" "$first" "$title" \
        "Artist $(printf %03d "$artist")" "Album $(printf %04d "$album")" "$number" "$year" \
        "$genre" >>"$work/tracks.tsv"
    done
  done

  # A distinct 16x16 cover per album, so each album has artwork of its own.
  tr '\t\n' '\0\0' <"$work/covers.tsv" | xargs -0 -r -n 2 -P "$jobs" bash -c \
    'ffmpeg -v error -y -f lavfi -i "color=c=0x$(printf %06x $(( ($0 * 2654435761) % 16777216 ))):s=16x16" -frames:v 1 "$1"'
  tr '\t\n' '\0\0' <"$work/tracks.tsv" | xargs -0 -r -n 8 -P "$jobs" bash -c 'write_track "$0" "$@"'

  echo "Generated $(find "$dir" -type f \( -name '*.flac' -o -name '*.mp3' \) | wc -l) tracks in $dir" \
    "($(du -sh "$dir" | cut -f1)) in $((($(date +%s%N) - started) / 1000000)) ms"
}

mutate() {
  local count="${1:-100}" file stamp
  stamp="$(date +%s)"
  : >"$work/tracks.tsv"
  while IFS= read -r file; do
    printf '%s\t%s\n' "$file" "Changed ${stamp} $(basename "$file")" >>"$work/tracks.tsv"
  done < <(find "$dir" -type f \( -name '*.flac' -o -name '*.mp3' \) | LC_ALL=C sort | head -n "$count")
  tr '\t\n' '\0\0' <"$work/tracks.tsv" | xargs -0 -r -n 2 -P "$jobs" bash -c 'retitle_track "$0" "$@"'
  echo "Retitled $(wc -l <"$work/tracks.tsv") tracks in $dir"
}

case "$mode" in
  generate) generate "${3:-}" "${4:-}" "${5:-}" ;;
  mutate) mutate "${3:-}" ;;
  *)
    echo "usage: $0 generate|mutate [dir] ..." >&2
    exit 2
    ;;
esac
