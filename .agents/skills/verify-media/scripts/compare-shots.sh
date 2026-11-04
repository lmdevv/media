#!/usr/bin/env bash
# Compares same-named screenshots in two folders, such as two `ios matrix` runs, below the status
# bar (whose clock always differs). Prints `same` when no channel of any pixel moved by more than 2
# of 255, which image encoding does on its own, and the largest change otherwise. Exits 1 when any
# file differs or is missing from AFTER, so "the iPhone did not change" is a command, not a look.
#
#   compare-shots.sh BEFORE_DIR AFTER_DIR [GLOB]   GLOB defaults to *.png
set -euo pipefail
(($# >= 2)) || { sed -n '7p' "$0" >&2; exit 2; }
before="$1" after="$2" glob="${3:-*.png}" differ=0 status_bar=200
shopt -s nullglob
for file in "$before"/$glob; do
  [[ -f "$after/$(basename "$file")" ]] || { echo "gone  $(basename "$file")"; differ=1; }
done
for file in "$after"/$glob; do
  name="$(basename "$file")"
  [[ -f "$before/$name" ]] || { echo "new   $name"; continue; }
  max="$(ffmpeg -loglevel error -i "$before/$name" -i "$file" -lavfi \
    "[0]crop=iw:ih-$status_bar:0:$status_bar[a];[1]crop=iw:ih-$status_bar:0:$status_bar[b];[a][b]blend=all_mode=difference,format=rgb24" \
    -f rawvideo - | node -e '
      let max = 0;
      process.stdin.on("data", (chunk) => { for (const byte of chunk) if (byte > max) max = byte; });
      process.stdin.on("end", () => console.log(max));')"
  if ((max <= 2)); then echo "same  $name"; else echo "diff  $name (a pixel moved by $max of 255)"; differ=1; fi
done
exit "$differ"
