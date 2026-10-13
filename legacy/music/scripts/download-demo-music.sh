#!/usr/bin/env bash
# Downloads a small CC BY / CC BY-SA demo library (5 releases, 28 tracks, about 520 MB) from the
# Internet Archive into ./demo-music, tags the one release that ships without tags, and writes
# CREDITS.md. Needs bash, curl, and ffmpeg.
#
#   scripts/download-demo-music.sh [target-dir]
set -euo pipefail
root="${1:-./demo-music}"
mkdir -p "$root"

# Each source filename is retained; nested artwork is flattened to its basename.
# Percent-encode the characters present in this particular file manifest.
download_album() {
  local artist="$1" album="$2" item="$3" cover="$4"
  shift 4
  local dir="$root/$artist/$album" file encoded filename
  mkdir -p "$dir"
  for file in "$@" "$cover"; do
    encoded="${file// /%20}"
    encoded="${encoded//\(/%28}"
    encoded="${encoded//\)/%29}"
    filename="${file##*/}"
    if [[ ! -s "$dir/$filename" ]]; then
      curl --fail --location --retry 3 --connect-timeout 20 \
        --output "$dir/$filename.part" \
        "https://archive.org/download/$item/$encoded"
      mv -- "$dir/$filename.part" "$dir/$filename"
    fi
  done
  # Let scanners recognize the original cover without renaming it.
  ln -sfn -- "${cover##*/}" "$dir/cover.jpg"
}

download_album \
  'raymundo mendoza' \
  'translations ep' \
  unfound53 \
  unfound53_artwork.jpg \
  unfound53_01_-_raymundo_mendoza_-_wrist_watch.flac \
  unfound53_02_-_raymundo_mendoza_-_toodaze.flac \
  unfound53_03_-_raymundo_mendoza_-_we_lift_offd.flac \
  unfound53_04_-_raymundo_mendoza_-_last_march.flac \
  unfound53_05_-_raymundo_mendoza_-_reaching.flac

download_album \
  Dadive \
  'Frightening Freighters EP' \
  MonoKraK207Dadive_FrighteningFreightersEP \
  monoKraK207_cover.JPG \
  '(monoKraK207) Dadive_Drifting_Cargo.flac' \
  '(monoKraK207) Dadive_Wandering_Vessel.flac'

download_album \
  'Doc & Lena Selyanina' \
  'Cosmic Lullabies' \
  mt018 \
  mt018_artwork_front400x400.jpg \
  01_-_Bell_Meditation.mp3 \
  02_-_Neptune.mp3 \
  03_-_Andromeda.mp3

download_album \
  'Doc & Lena Selyanina' \
  'Vienna Blue' \
  mt021 \
  mt021_artwork_front400x400.jpg \
  01_-_Wanderer.mp3 \
  02_-_Doppelganger.mp3 \
  03_-_Vienna_Blue.mp3 \
  04_-_Impromptu.mp3 \
  05_-_Naughty_Waltz.mp3 \
  06_-_An_die_Romanze.mp3 \
  07_-_Der_Leiermann.mp3

download_album \
  'Andy G. Cohen' \
  Prisma \
  andy-g.-cohen-prisma \
  'Andy G. Cohen - Prisma (300px).jpg' \
  'Andy G. Cohen - Prisma - 01 - Hoist.mp3' \
  'Andy G. Cohen - Prisma - 02 - Decapod.mp3' \
  'Andy G. Cohen - Prisma - 03 - In Awareness.mp3' \
  'Andy G. Cohen - Prisma - 04 - Gazing.mp3' \
  'Andy G. Cohen - Prisma - 05 - Minty Soak.mp3' \
  'Andy G. Cohen - Prisma - 06 - Our Young Guts.mp3' \
  'Andy G. Cohen - Prisma - 07 - Epoxy Resin.mp3' \
  'Andy G. Cohen - Prisma - 08 - Zwetschge.mp3' \
  'Andy G. Cohen - Prisma - 09 - Crunch Me Beautiful.mp3' \
  'Andy G. Cohen - Prisma - 10 - Upbridge.mp3' \
  'Andy G. Cohen - Prisma - 11 - Roost.mp3'

# The Dadive FLACs ship without tags; add them so the scanner shows the right artist and titles.
tag_flac() {
  local file="$1" title="$2" number="$3"
  [[ -s "$file" ]] || return 0
  ffmpeg -v error -y -i "$file" -map 0 -c copy -map_metadata -1 \
    -metadata ARTIST=Dadive -metadata ALBUMARTIST=Dadive \
    -metadata "ALBUM=Frightening Freighters EP" -metadata DATE=2018 -metadata GENRE=Techno \
    -metadata "TITLE=$title" -metadata "TRACKNUMBER=$number" "$file.tagged.flac"
  mv -- "$file.tagged.flac" "$file"
}
dadive="$root/Dadive/Frightening Freighters EP"
tag_flac "$dadive/(monoKraK207) Dadive_Drifting_Cargo.flac" "Drifting Cargo" 1
tag_flac "$dadive/(monoKraK207) Dadive_Wandering_Vessel.flac" "Wandering Vessel" 2

cat > "$root/CREDITS.md" <<'CREDITS'
# CREDITS

- **raymundo mendoza — translations ep (2010)**. Music by raymundo mendoza. Released by unfoundsound. [Source](https://archive.org/details/unfound53). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Dadive — Frightening Freighters EP (2018)**. Music by Dadive. Released by monoKraK. [Source](https://archive.org/details/MonoKraK207Dadive_FrighteningFreightersEP). Licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. These FLAC files are Internet Archive lossless encodings of the original WAV recordings.

- **Doc & Lena Selyanina — Cosmic Lullabies (2008)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt018). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Doc & Lena Selyanina — Vienna Blue (2009)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt021). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Additional source credits: guitar on “Wanderer”: Mahmoud el Kipikapi; voices on “Doppelgänger”: KraftiM, Softspace, TheOmen; Sigmund Freud recording: Internet Archive; sound samples: Corsica_S, Ingsey101, Acclivity. [Original release notes](https://archive.org/download/mt021/mt021_release_info.txt).

- **Andy G. Cohen — Prisma (2021)**. Music by Andy G. Cohen. Released by Andy G. Cohen. [Source](https://archive.org/details/andy-g.-cohen-prisma). Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Track-specific credit: Music: “Hoist”, “Decapod”, “In Awareness”, “Gazing”, “Minty Soak”, “Our Young Guts”, “Epoxy Resin”, “Zwetschge”, “Crunch Me Beautiful”, “Upbridge”, “Roost”; by Andy G. Cohen; released under Creative Commons Attribution 4.0 International (CC BY 4.0).

The artists and labels do not endorse this demo. The music retains its individual Creative Commons licenses. Any adaptations of CC BY-SA material must retain the applicable ShareAlike license.
CREDITS
