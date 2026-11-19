#!/usr/bin/env bash
# Builds a demo library of free, Creative Commons films and shows, laid out the way the scanner
# expects (Jellyfin/Kodi folders, NFO files, local artwork, sidecar subtitles), plus a five-minute
# "[movies] Feature Test" title whose versions exercise direct play, HDR10 tone mapping, multiple
# audio tracks, text and image subtitles, chapters, and SD interlaced video.
#
#   scripts/demo-library.sh [--dir DIR] [--set minimal|standard|full]
#
#   minimal   about 0.6 GB: Big Buck Bunny, Caminandes, and the Feature Test
#   standard  about 3 GB (default): adds Elephants Dream, Sintel, Tears of Steel, Cosmos Laundromat
#   full      about 6 GB: adds the six episodes of Pioneer One
#
# Add `DIR/Movies` as a movies library and `DIR/Shows` as a shows library. The NFO files carry
# full metadata, so titles match with `TMDB=off`. Downloads resume, and finished files are kept,
# so the script is safe to rerun. Credits and licenses are written to DIR/CREDITS.md.
set -euo pipefail

dir="${PWD}/demo-library"
set_name="standard"

while (($# > 0)); do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    --set) set_name="$2"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$set_name" in
  minimal | standard | full) ;;
  *) echo "--set must be minimal, standard, or full" >&2; exit 2 ;;
esac

for tool in curl ffmpeg ffprobe unzip; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

mkdir -p "$dir/Movies" "$dir/Shows" "$dir/.cache"
dir="$(cd "$dir" && pwd)"
cache="$dir/.cache"
movies="$dir/Movies"
shows="$dir/Shows"

blender="https://download.blender.org"
archive="https://archive.org/download"

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }

download() {
  local url="$1" dest="$2" max="${3:-}"
  [[ -s "$dest" ]] && return 0
  log "Downloading $(basename "$dest")"
  local range=(-C -)
  [[ -n "$max" ]] && range=(-r "0-$max")
  # download.blender.org sits behind Cloudflare, which sometimes answers a first request with
  # 403 and keeps doing so on that connection; a fresh curl process gets through.
  local attempt
  for attempt in 1 2 3 4 5 6; do
    curl -fsSL --retry 4 --retry-delay 5 "${range[@]}" -o "$dest.part" "$url" && break
    ((attempt < 6)) || return 1
    sleep $((attempt * 3))
  done
  case "$dest" in
    *.mp4 | *.mkv | *.mov | *.ogv)
      local codec
      codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 \
        "$dest.part" 2>/dev/null || true)"
      if [[ -z "$codec" || "$codec" == unknown ]]; then
        echo "$(basename "$dest") has no video stream ffmpeg can decode" >&2
        rm -f "$dest.part"
        return 1
      fi
      ;;
  esac
  mv "$dest.part" "$dest"
}

ff() {
  local out="$1"
  shift
  [[ -s "$out" ]] && return 0
  local tmp="${out%.*}.part.${out##*.}"
  # Explicit, because callers on the left of `||` run with `set -e` off.
  ffmpeg -nostdin -v error -y "$@" "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$out"
}

declare -A sources=(
  [bbb]="$archive/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4|big_buck_bunny_720p_surround.mp4"
  [ed]="$blender/ED/elephantsdream-1024-h264-st-aac.mov|elephantsdream-1024-h264-st-aac.mov"
  [sintel]="$blender/durian/movies/Sintel.2010.1080p.mkv|Sintel.2010.1080p.mkv"
  [sintel_head]="$blender/durian/movies/Sintel.2010.1080p.mkv|Sintel.2010.1080p.head.mkv|$((520 * 1024 * 1024))"
  [tos]="$blender/demo/movies/ToS/tears_of_steel_1080p.mov.zip|tears_of_steel_1080p.mov.zip"
  [cosmos]="$archive/CosmosLaundromatFirstCycle/Cosmos%20Laundromat%20-%20First%20Cycle%20(1080p).mp4|cosmos-laundromat-first-cycle-1080p.mp4"
  [cam1]="$archive/caminandes-1-llama-drama/1_Caminandes1_Llama_Drama_720p_vp8.ogv|1_Caminandes1_Llama_Drama_720p_vp8.ogv"
  [cam2]="$archive/caminandes-2-gran-dillama/1_Caminandes2_Gran_Dillama_720p_vp8.ogv|1_Caminandes2_Gran_Dillama_720p_vp8.ogv"
  [cam3]="$archive/caminandes-3-llamigos/1_Caminandes3_Llamigos_720p_vp8.ogv|1_Caminandes3_Llamigos_720p_vp8.ogv"
  [p1]="$archive/pioneer-one-ep.-1-earthfall-pilot/PIONEER%20ONE%20Ep.1%20Earthfall-Pilot.mp4|pioneer-one-s01e01.mp4"
  [p2]="$archive/pioneer-one-ep.-2-the-man-from-mars_202608/PIONEER%20ONE%20Ep.2%20The%20Man%20From%20Mars.mp4|pioneer-one-s01e02.mp4"
  [p3]="$archive/pioneer-one-ep.-3-alone-in-the-night/PIONEER%20ONE%20Ep.3%20Alone%20in%20the%20Night.mp4|pioneer-one-s01e03.mp4"
  [p4]="$archive/pioneer-one-ep.-4-triangular-diploma/PIONEER%20ONE%20Ep.4%20Triangular%20Diploma.mp4|pioneer-one-s01e04.mp4"
  [p5]="$archive/pioneer-one-ep.-5-sea-change/PIONEER%20ONE%20Ep.5%20Sea%20Change.mp4|pioneer-one-s01e05.mp4"
  [p6]="$archive/pioneer-one-ep.-6-war-of-the-world-3mp-4_202608/PIONEER%20ONE%20Ep.6%20War%20of%20the%20World3mp4.mp4|pioneer-one-s01e06.mp4"
)

fetch() {
  local url file max
  IFS='|' read -r url file max <<<"${sources[$1]}"
  download "$url" "$cache/$file" "$max" >&2
  echo "$cache/$file"
}

# archive.org is slow per connection, so its files download in parallel; download.blender.org
# refuses parallel requests, so its files queue.
prefetch() {
  local key pids=() failed=0 queued=()
  for key in "$@"; do
    if [[ "${sources[$key]}" == "$blender"/* ]]; then
      queued+=("$key")
    else
      fetch "$key" >/dev/null &
      pids+=("$!")
    fi
  done
  if ((${#queued[@]} > 0)); then
    (for key in "${queued[@]}"; do fetch "$key" >/dev/null; done) &
    pids+=("$!")
  fi
  for key in "${pids[@]}"; do wait "$key" || failed=1; done
  ((failed == 0)) || { echo "some downloads failed; rerun the script to resume" >&2; exit 1; }
}

unzip_one() {
  local zip="$1" dest="$2"
  [[ -s "$dest" ]] && return 0
  local member
  member="$(unzip -Z1 "$zip" | grep -iE '\.(mov|mp4|mkv|avi)$' | head -n 1)"
  unzip -p "$zip" "$member" >"$dest.part"
  mv "$dest.part" "$dest"
}

duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" | cut -d. -f1; }

artwork() {
  local video="$1" folder="$2" prefix="${3:-}" length
  length="$(duration "$video")"
  local poster="$folder/${prefix}poster.jpg" fanart="$folder/${prefix}fanart.jpg"
  ff "$poster" -ss "$((length * 2 / 5))" -i "$video" -frames:v 1 \
    -vf "crop=ih*2/3:ih,scale=600:900" -q:v 3
  ff "$fanart" -ss "$((length / 4))" -i "$video" -frames:v 1 -vf "scale=1920:-2" -q:v 3
}

thumb() {
  local video="$1" dest="$2" length
  [[ -s "$dest" ]] && return 0
  length="$(duration "$video")"
  ff "$dest" -ss "$((length / 3))" -i "$video" -frames:v 1 -vf "scale=1280:-2" -q:v 3
}

place() {
  [[ -e "$2" ]] && return 0
  ln "$1" "$2" 2>/dev/null && return 0
  cp "$1" "$2.part"
  mv "$2.part" "$2"
}

big_buck_bunny() {
  local folder="$movies/Big Buck Bunny (2008)" src
  mkdir -p "$folder"
  src="$(fetch bbb)"
  place "$src" "$folder/Big Buck Bunny (2008).mp4"
  artwork "$src" "$folder"
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Big Buck Bunny</title>
  <year>2008</year>
  <runtime>10</runtime>
  <plot>A giant, good-natured rabbit's quiet morning in the forest is spoiled by three bullying rodents, so he sets out to teach them a lesson they won't forget.</plot>
  <tagline>A comedy about a well-tempered rabbit.</tagline>
  <genre>Animation</genre>
  <genre>Comedy</genre>
  <genre>Short</genre>
  <studio>Blender Institute</studio>
  <country>Netherlands</country>
  <director>Sacha Goedegebure</director>
  <producer>Ton Roosendaal</producer>
  <mpaa>NR</mpaa>
  <set><name>Blender Open Movies</name><overview>Short films made in the open with Blender and released under Creative Commons.</overview></set>
  <tag>creative commons</tag>
  <tag>open movie</tag>
  <uniqueid type="imdb" default="true">tt1254207</uniqueid>
  <uniqueid type="tmdb">10378</uniqueid>
</movie>
EOF
}

elephants_dream() {
  local folder="$movies/Elephants Dream (2006)" src
  mkdir -p "$folder"
  src="$(fetch ed)"
  place "$src" "$folder/Elephants Dream (2006).mov"
  artwork "$src" "$folder"
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Elephants Dream</title>
  <year>2006</year>
  <premiered>2006-03-24</premiered>
  <runtime>11</runtime>
  <plot>Two men, the old Proog and the young Emo, wander an endless and strange machine of a world that each of them understands in a very different way.</plot>
  <genre>Animation</genre>
  <genre>Science Fiction</genre>
  <genre>Short</genre>
  <studio>Orange Open Movie Project</studio>
  <country>Netherlands</country>
  <director>Bassam Kurdali</director>
  <producer>Ton Roosendaal</producer>
  <actor><name>Tygo Gernandt</name><role>Proog (voice)</role><order>0</order></actor>
  <actor><name>Cas Jansen</name><role>Emo (voice)</role><order>1</order></actor>
  <mpaa>NR</mpaa>
  <set><name>Blender Open Movies</name></set>
  <tag>creative commons</tag>
  <tag>open movie</tag>
  <uniqueid type="imdb" default="true">tt0807840</uniqueid>
  <uniqueid type="tmdb">9761</uniqueid>
</movie>
EOF
}

sintel_source() {
  if [[ "$set_name" == "minimal" ]]; then fetch sintel_head; else fetch sintel; fi
}

sintel() {
  local folder="$movies/Sintel (2010)" src
  mkdir -p "$folder"
  src="$(sintel_source)"
  place "$src" "$folder/Sintel (2010).mkv"
  artwork "$src" "$folder"
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Sintel</title>
  <year>2010</year>
  <premiered>2010-09-27</premiered>
  <runtime>15</runtime>
  <plot>A lonely young woman crosses a harsh and dangerous land in search of the baby dragon she once rescued, raised, and lost.</plot>
  <genre>Animation</genre>
  <genre>Fantasy</genre>
  <genre>Short</genre>
  <studio>Blender Institute</studio>
  <country>Netherlands</country>
  <director>Colin Levy</director>
  <credits>Martin Lodewijk</credits>
  <producer>Ton Roosendaal</producer>
  <actor><name>Halina Reijn</name><role>Sintel (voice)</role><order>0</order></actor>
  <actor><name>Thom Hoffman</name><role>Shaman (voice)</role><order>1</order></actor>
  <mpaa>NR</mpaa>
  <set><name>Blender Open Movies</name></set>
  <tag>creative commons</tag>
  <tag>open movie</tag>
  <tag>dragon</tag>
  <uniqueid type="imdb" default="true">tt1727587</uniqueid>
  <uniqueid type="tmdb">45745</uniqueid>
</movie>
EOF
}

tears_of_steel() {
  local folder="$movies/Tears of Steel (2012)" zip src="$cache/tears_of_steel_1080p.mov"
  mkdir -p "$folder"
  zip="$(fetch tos)"
  unzip_one "$zip" "$src"
  place "$src" "$folder/Tears of Steel (2012).mov"
  artwork "$src" "$folder"
  local pair code file
  for pair in en:TOS-en de:TOS-de es:TOS-es fr:TOS-fr-orig it:TOS-it nl:TOS-nl no:TOS-no \
    ru:TOS-ru ja:TOS-JP pt.Brazil:TOS-PT-BR pt:TOS-PT-PT cs:TOS-CZ da:TOS-Dansk el:TOS-GK \
    he:TOS-HE hu:TOS-HU id:TOS-Indonesian fa:TOS-Persian zh:TOS-CH hr:TOS-Croatian; do
    code="${pair%%:*}" file="${pair#*:}"
    # download.blender.org throttles bursts of requests, so pace them.
    [[ -s "$folder/Tears of Steel (2012).$code.srt" ]] || sleep 1
    download "$blender/demo/movies/ToS/subtitles/$file.srt" "$folder/Tears of Steel (2012).$code.srt"
  done
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Tears of Steel</title>
  <year>2012</year>
  <runtime>12</runtime>
  <plot>In a future Amsterdam overrun by robots, a group of scientists and warriors tries to save the world by revisiting the painful breakup that started it all.</plot>
  <genre>Science Fiction</genre>
  <genre>Action</genre>
  <genre>Short</genre>
  <studio>Blender Institute</studio>
  <country>Netherlands</country>
  <director>Ian Hubert</director>
  <producer>Ton Roosendaal</producer>
  <actor><name>Derek de Lint</name><role>Old Thom</role><order>0</order></actor>
  <mpaa>NR</mpaa>
  <set><name>Blender Open Movies</name></set>
  <tag>creative commons</tag>
  <tag>open movie</tag>
  <tag>robots</tag>
  <uniqueid type="imdb" default="true">tt2285752</uniqueid>
  <uniqueid type="tmdb">133701</uniqueid>
</movie>
EOF
}

cosmos_laundromat() {
  local folder="$movies/Cosmos Laundromat - First Cycle (2015)" src
  local item="$archive/CosmosLaundromatFirstCycle"
  mkdir -p "$folder"
  src="$(fetch cosmos)"
  place "$src" "$folder/Cosmos Laundromat - First Cycle (2015).mp4"
  artwork "$src" "$folder"
  local code
  for code in en es fr it; do
    download "$item/CosmosLaundromat-FirstCycle1080p.$code.srt" \
      "$folder/Cosmos Laundromat - First Cycle (2015).$code.srt"
  done
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Cosmos Laundromat: First Cycle</title>
  <sorttitle>Cosmos Laundromat 1</sorttitle>
  <year>2015</year>
  <premiered>2015-08-10</premiered>
  <runtime>12</runtime>
  <plot>On a desolate island, a despairing sheep named Franck meets a mysterious salesman who offers him the gift of a lifetime, and gets far more than he bargained for.</plot>
  <genre>Animation</genre>
  <genre>Fantasy</genre>
  <genre>Short</genre>
  <studio>Blender Institute</studio>
  <country>Netherlands</country>
  <director>Mathieu Auvray</director>
  <credits>Esther Wouda</credits>
  <producer>Ton Roosendaal</producer>
  <mpaa>NR</mpaa>
  <set><name>Blender Open Movies</name></set>
  <tag>creative commons</tag>
  <tag>open movie</tag>
  <uniqueid type="imdb" default="true">tt4957236</uniqueid>
  <uniqueid type="tmdb">358332</uniqueid>
</movie>
EOF
}

xml_attr() {
  local value="$1"
  value="${value//&/&amp;}" value="${value//</&lt;}" value="${value//>/&gt;}"
  printf '%s' "${value//\"/&quot;}"
}

# ffmpeg can't turn text into bitmaps, so spumux (dvdauthor) renders the SRT onto a DVD stream and
# ffmpeg lifts the subtitle track out.
image_subtitle() {
  local video="$1" out="$2" font srt="$cache/feature-test-en.srt" dvd="$cache/feature-test-dvd.mpg"
  command -v spumux >/dev/null && command -v fc-match >/dev/null || return 1
  font="$(fc-match -f '%{file}' 'DejaVu Sans:bold')"
  [[ -n "$font" ]] || return 1
  log "Feature Test: rendering the image subtitle"
  ff "$srt" -i "$video" -map 0:s:m:language:eng || return 1
  ff "$dvd" -f lavfi -i "color=c=black:s=720x576:r=25" -t 300 -target pal-dvd -an || return 1
  cat >"$cache/spumux.xml" <<EOF
<subpictures format="PAL"><stream><textsub filename="$(xml_attr "$srt")" characterset="UTF-8" font="$(xml_attr "$font")"
  fontsize="28.0" horizontal-alignment="center" vertical-alignment="bottom" left-margin="60"
  right-margin="60" bottom-margin="40" subtitle-fps="25" movie-fps="25" movie-width="720"
  movie-height="576"/></stream></subpictures>
EOF
  local status=0
  spumux -s0 "$cache/spumux.xml" <"$dvd" >"$dvd.subs.mpg" 2>"$cache/spumux.log" || status=1
  # The first cue starts late, so probe the whole stream to find the subtitle track. Copied out
  # alone, the track would be shifted to start at zero; keep its timestamps, less the DVD
  # stream's own start.
  if ((status == 0)); then
    local start
    start="$(ffprobe -v error -show_entries format=start_time -of csv=p=0 "$dvd.subs.mpg" || true)"
    if [[ "$start" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      ff "$out" -analyzeduration 400M -probesize 200M -copyts -i "$dvd.subs.mpg" -map 0:s:0 \
        -c:s copy -avoid_negative_ts disabled -output_ts_offset "-$start" || status=1
    else
      status=1
    fi
  fi
  rm -f "$dvd" "$dvd.subs.mpg"
  return "$status"
}

feature_test() {
  local folder="$movies/[movies] Feature Test (2010)" src cut="$cache/feature-test-cut.mkv"
  local base="$folder/[movies] Feature Test (2010)"
  mkdir -p "$folder"
  src="$(sintel_source)"

  if [[ ! -s "$cut" ]]; then
    log "Cutting the five-minute Feature Test source"
    ffmpeg -v error -y -i "$src" -t 300 -map 0 -c copy "$cut.part.mkv"
    mv "$cut.part.mkv" "$cut"
  fi

  local chapters="$cache/feature-test-chapters.txt"
  cat >"$chapters" <<'EOF'
;FFMETADATA1
title=[movies] Feature Test
[CHAPTER]
TIMEBASE=1/1000
START=0
END=60000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=60000
END=130000
title=The Wall
[CHAPTER]
TIMEBASE=1/1000
START=130000
END=200000
title=Scales
[CHAPTER]
TIMEBASE=1/1000
START=200000
END=300000
title=The Chase
EOF

  log "Feature Test: Direct Play"
  ff "$base {edition-Direct Play}.mp4" -i "$cut" -i "$chapters" -map 0:v:0 -map 0:a:0 \
    -map_chapters 1 -c:v copy -c:a aac -ac 2 -b:a 192k -movflags +faststart
  local pair
  for pair in de:ger en:eng es:spa fr:fre it:ita nl:dut pl:pol pt:por ru:rus vi:vie; do
    ff "$base {edition-Direct Play}.${pair%%:*}.srt" -i "$cut" -map "0:s:m:language:${pair#*:}"
  done

  if [[ ! -s "$base {edition-HDR10 HEVC}.mkv" ]]; then
    log "Feature Test: HDR10 HEVC (takes a few minutes)"
    # Converts the SDR film into real PQ/BT.2020 when ffmpeg has zimg; otherwise only tags it.
    # The source goes to 16 bits before zscale, so the PQ signal is never quantised to 8 bits.
    local tags="setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc"
    local hdr_filter="format=yuv420p10le,$tags" filters
    filters="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
    [[ "$filters" == *" zscale "* ]] &&
      hdr_filter="format=yuv444p16le,zscale=tin=bt709:pin=bt709:min=bt709:t=smpte2084:p=bt2020:m=bt2020nc:npl=203,format=yuv420p10le,$tags"
    ff "$base {edition-HDR10 HEVC}.mkv" -i "$cut" -i "$chapters" -map 0:v:0 -map 0:a:0 \
      -map_chapters 1 -vf "$hdr_filter" -c:v libx265 -preset fast -crf 22 -pix_fmt yuv420p10le \
      -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
      -x265-params "hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error" \
      -c:a copy -metadata:s:a:0 "title=Surround 5.1"
  fi

  local vobsub="$cache/feature-test-en.vobsub.mkv" image_subs=()
  [[ -s "$vobsub" ]] || image_subtitle "$cut" "$vobsub" ||
    log "Couldn't render the image subtitle (needs spumux from dvdauthor and fontconfig); skipping it"
  if [[ -s "$vobsub" ]]; then
    image_subs=(-i "$vobsub")
    local version
    for version in "Multi-Audio and Subtitles" "SD Interlaced MPEG-2"; do
      local file="$base {edition-$version}.mkv" codecs
      [[ -s "$file" ]] || continue
      codecs="$(ffprobe -v error -show_entries stream=codec_name -of csv=p=0 "$file" || true)"
      [[ "$codecs" == *dvd_subtitle* ]] || rm -f "$file"
    done
  fi

  log "Feature Test: Multi-Audio and Subtitles"
  local image_map=()
  ((${#image_subs[@]} > 0)) && image_map=(-map 2:s:0 -metadata:s:s:10 "title=English (image)"
    -metadata:s:s:10 language=eng)
  ff "$base {edition-Multi-Audio and Subtitles}.mkv" -i "$cut" -i "$chapters" "${image_subs[@]}" \
    -map 0:v:0 -map 0:a:0 -map 0:a:0 -map 0:s "${image_map[@]}" -map_chapters 1 \
    -c:v copy -c:a:0 copy -c:a:1 aac -ac:a:1 2 -b:a:1 192k -c:s copy \
    -metadata:s:a:0 "title=Surround 5.1" -metadata:s:a:0 language=eng \
    -metadata:s:a:1 title=Stereo -metadata:s:a:1 language=eng \
    -disposition:a:0 default -disposition:a:1 0

  # `interlace` weaves pairs of frames, so it needs 50 progressive frames a second in.
  log "Feature Test: SD Interlaced MPEG-2"
  local sd_map=()
  ((${#image_subs[@]} > 0)) && sd_map=(-map 1:s:0 -c:s copy -metadata:s:s:0 language=eng)
  ff "$base {edition-SD Interlaced MPEG-2}.mkv" -i "$cut" "${image_subs[@]}" -map 0:v:0 \
    -map 0:a:0 "${sd_map[@]}" -vf "scale=720:576,setsar=64/45,fps=50,interlace=scan=tff" \
    -c:v mpeg2video -b:v 5M -flags +ilme+ildct -top 1 -c:a mp2 -ac 2 -b:a 224k \
    -metadata:s:a:0 title=Stereo

  artwork "$cut" "$folder"
  cat >"$folder/movie.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>[movies] Feature Test</title>
  <sorttitle>movies Feature Test</sorttitle>
  <year>2010</year>
  <runtime>5</runtime>
  <plot>The first five minutes of Sintel in four versions: direct play with chapters and sidecar subtitles, HDR10 HEVC for tone mapping, multiple audio tracks with text and image subtitles, and interlaced SD MPEG-2.</plot>
  <genre>Animation</genre>
  <genre>Fantasy</genre>
  <studio>Blender Institute</studio>
  <director>Colin Levy</director>
  <actor><name>Halina Reijn</name><role>Sintel (voice)</role><order>0</order></actor>
  <mpaa>NR</mpaa>
  <tag>test</tag>
  <!-- No provider ids: Sintel's would merge this title into Sintel's. A provider match needs
       the same title and year, so "Feature Test" (2010) stays unmatched. -->
</movie>
EOF
}

caminandes() {
  local folder="$shows/Caminandes (2013)" season
  season="$folder/Season 01"
  mkdir -p "$season"
  local entries=(
    "1|cam1|Llama Drama|2013|tt6059374|253777|Koro the llama wants the green grass on the other side of the road, and nothing, least of all traffic, will stop him from trying."
    "2|cam2|Gran Dillama|2013|tt3434172|253774|An electric fence stands between Koro and a field of fresh grass, and he tries every trick he knows to get past it."
    "3|cam3|Llamigos|2016|tt7993892|406956|Winter has come to Patagonia, and Koro meets Oti, a pesky penguin with his eye on the same last red berries."
  )
  local entry number key title year imdb tmdb plot name src
  for entry in "${entries[@]}"; do
    IFS='|' read -r number key title year imdb tmdb plot <<<"$entry"
    name="Caminandes (2013) - S01E0$number - $title"
    src="$(fetch "$key")"
    place "$src" "$season/$name.ogv"
    thumb "$src" "$season/$name-thumb.jpg"
    cat >"$season/$name.nfo" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>$title</title>
  <season>1</season>
  <episode>$number</episode>
  <aired>$year-01-01</aired>
  <plot>$plot</plot>
  <director>Pablo Vazquez</director>
  <uniqueid type="imdb" default="true">$imdb</uniqueid>
  <uniqueid type="tmdb">$tmdb</uniqueid>
</episodedetails>
EOF
  done
  artwork "$(fetch cam2)" "$folder"
  cat >"$folder/tvshow.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>Caminandes</title>
  <year>2013</year>
  <premiered>2013-01-01</premiered>
  <plot>Short comedies about Koro, a stubborn llama from Patagonia who always finds a way, eventually. Made with Blender and released under Creative Commons.</plot>
  <genre>Animation</genre>
  <genre>Comedy</genre>
  <genre>Family</genre>
  <studio>Blender Institute</studio>
  <status>Ended</status>
  <mpaa>NR</mpaa>
  <tag>creative commons</tag>
  <tag>open movie</tag>
</tvshow>
EOF
}

pioneer_one() {
  local folder="$shows/Pioneer One (2010)" season
  season="$folder/Season 01"
  mkdir -p "$season"
  local titles=("Earthfall" "The Man from Mars" "Alone in the Night" "Triangular Diploma"
    "Sea Change" "War of the World")
  local number name src
  for number in 1 2 3 4 5 6; do
    name="Pioneer One (2010) - S01E0$number - ${titles[number - 1]}"
    src="$(fetch "p$number")"
    place "$src" "$season/$name.mp4"
    thumb "$src" "$season/$name-thumb.jpg"
  done
  artwork "$(fetch p1)" "$folder"
  cat >"$folder/tvshow.nfo" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>Pioneer One</title>
  <year>2010</year>
  <plot>An object falls from the sky over Montana and spreads radiation across the plains. Homeland Security agents sent to contain it find a man inside who may have come from Mars. An independent drama released under Creative Commons.</plot>
  <genre>Drama</genre>
  <genre>Science Fiction</genre>
  <credits>Josh Bernhard</credits>
  <credits>Bracey Smith</credits>
  <status>Ended</status>
  <mpaa>NR</mpaa>
  <tag>creative commons</tag>
  <uniqueid type="imdb" default="true">tt1748166</uniqueid>
  <uniqueid type="tmdb">33050</uniqueid>
  <uniqueid type="tvdb">170551</uniqueid>
</tvshow>
EOF
}

credits() {
  cat >"$dir/CREDITS.md" <<'EOF'
# Demo library credits

Every film here is free to share under the license listed. The NFO summaries are our own words.

| Title | Made by | License | Source |
| --- | --- | --- | --- |
| Big Buck Bunny (2008) | Blender Foundation, peach.blender.org | CC BY 3.0 | archive.org/details/BigBuckBunny_124 |
| Elephants Dream (2006) | Blender Foundation, orange.blender.org | CC BY 2.5 | download.blender.org/ED |
| Sintel (2010) | Blender Foundation, durian.blender.org | CC BY 3.0 | download.blender.org/durian |
| Tears of Steel (2012) | Blender Foundation, mango.blender.org | CC BY 3.0 | download.blender.org/demo/movies/ToS |
| Cosmos Laundromat: First Cycle (2015) | Blender Institute, gooseberry.blender.org | CC BY 4.0 | archive.org/details/CosmosLaundromatFirstCycle |
| Caminandes (2013-2016) | Blender Institute, caminandes.com | CC BY | archive.org (caminandes-1/2/3) |
| Pioneer One (2010) | Josh Bernhard and Bracey Smith | CC BY-SA 4.0 | archive.org (pioneer-one-ep.-1 … 6) |

The "[movies] Feature Test" versions are cut and re-encoded from Sintel (CC BY 3.0, Blender
Foundation). Posters, backgrounds, and stills are frames taken from each film.
EOF
}

log "Building the $set_name demo library in $dir"
case "$set_name" in
  minimal) prefetch bbb sintel_head cam1 cam2 cam3 ;;
  standard) prefetch bbb ed sintel tos cosmos cam1 cam2 cam3 ;;
  full) prefetch bbb ed sintel tos cosmos cam1 cam2 cam3 p1 p2 p3 p4 p5 p6 ;;
esac
big_buck_bunny
caminandes
feature_test
if [[ "$set_name" != "minimal" ]]; then
  elephants_dream
  sintel
  tears_of_steel
  cosmos_laundromat
fi
[[ "$set_name" == "full" ]] && pioneer_one
credits

log "Done. Add these folders as libraries:"
echo "  movies: $movies"
echo "  shows:  $shows"
du -sh --exclude=.cache "$dir" 2>/dev/null | cut -f1 | sed 's/^/  size:   /'
