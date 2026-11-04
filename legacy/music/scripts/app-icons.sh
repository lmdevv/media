#!/usr/bin/env bash
# Draws the [music] iOS app icons and launch-screen wordmarks into apps/mobile/assets/icon and
# apps/mobile/assets/splash. Colors and tracking come from the Paper tokens in
# packages/ui/src/styles/globals.css and the type is Inter ExtraBold, so rerun this after either
# changes and commit the outputs. Pass a path to also write a contact sheet of every output.
#
#   scripts/app-icons.sh [contact-sheet.png]
#
# Needs ImageMagick 7; without `magick` on PATH it reruns itself in a `nix shell` with the repo
# flake's pinned nixpkgs.
#
# The icon splits the space Inter puts between `[`, `m` and `]` into two equal gaps, since the
# sidebearings alone leave the left gap wider than the right. Expo flattens the light and tinted
# icons onto white, so both are opaque; the dark icon keeps a transparent ground for iOS to fill.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v magick >/dev/null; then
  exec nix shell --inputs-from "$root" nixpkgs#imagemagick --command "$0" "$@"
fi

tokens="$root/packages/ui/src/styles/globals.css"
font="$root/apps/mobile/assets/fonts/Inter-ExtraBold.ttf"
icons="$root/apps/mobile/assets/icon"
splash="$root/apps/mobile/assets/splash"
sheet="${1:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

token() {
  local value
  value="$(sed -n "s/^ *--$1: *\([^;]*\);.*/\1/p" "$tokens" | head -n 1)"

  if [[ -z "$value" ]]; then
    echo "app-icons: no value for --$1 in $tokens" >&2
    exit 1
  fi

  printf '%s' "$value"
}

accent="$(token color-accent)"
on_accent="$(token color-on-accent)"
dark_accent="$(token color-dark-accent)"
dark_canvas="$(token color-dark-canvas)"
dark_text="$(token color-dark-text)"
bg="$(token color-bg)"
text="$(token color-text)"
tracking="$(token tracking-display)"
tracking="${tracking%em}"

size=1024
point=1000
icon_width=600
wordmark_width=820

write_png() {
  magick "${@:1:$#-1}" -depth 8 -strip -define png:exclude-chunks=date,time "${@: -1}"
}

kerning="$(awk -v p="$point" -v t="$tracking" 'BEGIN { printf "%.2f", p * t }')"

glyph() {
  magick -background none -fill white -font "$font" -pointsize "$point" -kerning "$kerning" \
    label:"$1" -define trim:edges=east,west -trim +repage "$2"
}

width() {
  magick identify -format '%w' "$1"
}

glyph '[' "$work/open.png"
glyph 'm' "$work/m.png"
glyph ']' "$work/close.png"
glyph '[m]' "$work/set.png"
glyphs=$(($(width "$work/open.png") + $(width "$work/m.png") + $(width "$work/close.png")))
gap=$((($(width "$work/set.png") - glyphs) / 2))
magick "$work/open.png" -size "${gap}x1" xc:none "$work/m.png" -size "${gap}x1" xc:none \
  "$work/close.png" -background none +append -trim +repage "$work/mark.png"

magick -background none -fill white -font "$font" -pointsize "$point" -kerning "$kerning" \
  label:'[music]' -trim +repage "$work/wordmark.png"

on_canvas() {
  local ground="$1" art="$2" width="$3" fill="$4"
  shift 4
  write_png -size "${size}x${size}" "xc:$ground" \
    \( "$art" -resize "${width}x" -fill "$fill" -colorize 100 \) \
    -gravity center -composite "$@"
}

mkdir -p "$icons" "$splash"

on_canvas "$accent" "$work/mark.png" "$icon_width" "$on_accent" -alpha off "PNG24:$icons/light.png"
on_canvas none "$work/mark.png" "$icon_width" "$dark_accent" "PNG32:$icons/dark.png"
on_canvas "$dark_canvas" "$work/mark.png" "$icon_width" "$dark_text" -alpha off \
  "PNG24:$icons/tinted.png"

on_canvas none "$work/wordmark.png" "$wordmark_width" "$text" "PNG32:$splash/wordmark.png"
on_canvas none "$work/wordmark.png" "$wordmark_width" "$dark_text" \
  "PNG32:$splash/wordmark-dark.png"

echo "app-icons: wrote icon/{light,dark,tinted}.png and splash/wordmark{,-dark}.png in apps/mobile/assets"

if [[ -z "$sheet" ]]; then
  exit 0
fi

tile=256
sheet_ground="$(token color-border)"
radius="$(awk -v t="$tile" 'BEGIN { printf "%d", t * 0.2237 }')"
magick -size "${tile}x${tile}" xc:none -fill white \
  -draw "roundrectangle 0,0,$((tile - 1)),$((tile - 1)),$radius,$radius" "$work/squircle.png"

home_icon() {
  magick -size "${size}x${size}" "xc:$1" "$2" -composite -resize "${tile}x${tile}" -alpha set \
    "$work/squircle.png" -compose DstIn -composite \
    -compose Over -background "$sheet_ground" -flatten "$3"
}

home_icon "$accent" "$icons/light.png" "$work/sheet-light.png"
home_icon "$dark_canvas" "$icons/dark.png" "$work/sheet-dark.png"
home_icon "$dark_canvas" "$icons/tinted.png" "$work/sheet-tinted.png"

phone_width=390
phone_height=844
splash_width=200
phone_scale="$(awk -v t="$tile" -v w="$phone_width" 'BEGIN { printf "%.4f", t / w }')"
phone_h="$(awk -v s="$phone_scale" -v h="$phone_height" 'BEGIN { printf "%d", s * h }')"
splash_px="$(awk -v s="$phone_scale" -v w="$splash_width" 'BEGIN { printf "%d", s * w }')"

launch_screen() {
  magick -size "${tile}x${phone_h}" "xc:$1" \( "$2" -resize "${splash_px}x${splash_px}" \) \
    -gravity center -composite "$3"
}

launch_screen "$bg" "$splash/wordmark.png" "$work/sheet-splash.png"
launch_screen "$dark_canvas" "$splash/wordmark-dark.png" "$work/sheet-splash-dark.png"

mkdir -p "$(dirname "$sheet")"
magick montage -font "$root/apps/mobile/assets/fonts/Inter-Medium.ttf" -pointsize 18 \
  -background "$sheet_ground" -geometry +32+32 -tile 5x1 \
  -label 'icon light' "$work/sheet-light.png" \
  -label 'icon dark (on dark-canvas)' "$work/sheet-dark.png" \
  -label 'icon tinted' "$work/sheet-tinted.png" \
  -label "splash light (${splash_width}pt)" "$work/sheet-splash.png" \
  -label "splash dark (${splash_width}pt)" "$work/sheet-splash-dark.png" \
  "$sheet"

echo "app-icons: wrote $sheet"
