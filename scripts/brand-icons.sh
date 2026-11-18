#!/usr/bin/env bash
# Writes every icon the apps ship from the Lar marks in brand/: the account client's favicons
# (the Flat logo), the movies and music web clients' favicons, touch icons, app icons and
# manifests, and the iOS apps' icons and splash images. Rerun it after a mark changes and commit
# the outputs; reruns write identical files.
#
# Needs ImageMagick 7 with its librsvg delegate; without `magick` on PATH it reruns itself in a
# `nix shell` with the repo flake's pinned nixpkgs.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v magick >/dev/null; then
  exec nix shell --inputs-from "$root" nixpkgs#imagemagick --command "$0" "$@"
fi

brand="$root/brand"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

token() {
  local sheet="$1" name="$2" value
  value="$(sed -n "s/^ *--color-$name: *\(#[0-9a-fA-F]\{6\}\);.*/\1/p" "$sheet" | head -n 1)"

  if [[ -z "$value" ]]; then
    echo "brand-icons: no hex value for --color-$name in $sheet" >&2
    exit 1
  fi

  printf '%s' "$value"
}

# Writes `file` with the one occurrence of `from` replaced by `to`, and fails when `from` is not
# in `file` exactly once, so a changed mark cannot silently skip a variant.
replace_once() {
  local file="$1" from="$2" to="$3" out="$4"

  if [[ "$(grep -oF -- "$from" "$file" | wc -l)" -ne 1 ]]; then
    echo "brand-icons: expected one '$from' in $file" >&2
    exit 1
  fi

  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$file" >"$out"
}

# Renders `svg` to a `size`-pixel square PNG without metadata.
render() {
  local svg="$1" size="$2" out="$3"
  magick -background none -density "$((96 * size / 100 * 4))" "$svg" -resize "${size}x${size}" \
    -depth 8 -strip -define png:exclude-chunks=date,time "$out"
}

# Packs `svg` at 16, 32 and 48 pixels into `out`.
ico() {
  local svg="$1" out="$2" size
  for size in 16 32 48; do
    render "$svg" "$size" "$work/ico-$size.png"
  done
  magick "$work/ico-16.png" "$work/ico-32.png" "$work/ico-48.png" "$out"
}

# The account client: the Flat logo, ink on a light browser tab and flat white on a dark one.
account="$root/apps/web-account/public"
mkdir -p "$account"
replace_once "$brand/lar-flat.svg" 'fill="#F1F1EC"' 'class="cube"' "$work/flat.svg"
replace_once "$work/flat.svg" '<defs>' \
  '<style>.cube{fill:#141416}@media (prefers-color-scheme:dark){.cube{fill:#F1F1EC}}</style><defs>' \
  "$account/favicon.svg"
# A .ico cannot follow the tab's scheme, so it sets the Flat logo on the brand's ground.
replace_once "$brand/lar-flat.svg" 'viewBox="0 0 100 100"><defs>' \
  'viewBox="-12 -12 124 124"><rect x="-12" y="-12" width="124" height="124" rx="28" fill="#0E0F12"/><defs>' \
  "$work/flat-ground.svg"
ico "$work/flat-ground.svg" "$account/favicon.ico"

# Writes app `app`'s icons from brand/lar-<app>.svg: the rounded tile as is, a full-bleed square
# for iOS and touch icons, which the platform masks, and a maskable icon whose mark stays inside
# the central circle of 80% diameter that every mask keeps.
app_icons() {
  local app="$1" name="$2" description="$3" background="$4"
  local tile="$brand/lar-$app.svg" public="$root/apps/web-$app/public"
  local images="$root/apps/mobile-$app/assets/images"
  mkdir -p "$public" "$images"

  replace_once "$tile" ' rx="23"' '' "$work/$app-square.svg"
  replace_once "$work/$app-square.svg" '<g id="mark">' \
    '<g id="mark" transform="translate(50 50) scale(.8) translate(-50 -50)">' "$work/$app-maskable.svg"

  cp "$tile" "$public/favicon.svg"
  ico "$tile" "$public/favicon.ico"
  render "$tile" 192 "$public/icon-192.png"
  render "$tile" 512 "$public/icon-512.png"
  render "$work/$app-maskable.svg" 512 "$public/icon-maskable-512.png"
  render "$work/$app-square.svg" 180 "$public/apple-touch-icon.png"

  render "$work/$app-square.svg" 1024 "$work/$app-icon.png"
  magick "$work/$app-icon.png" -alpha off -strip -define png:exclude-chunks=date,time \
    "$images/icon.png"
  render "$tile" 600 "$images/splash.png"

  cat >"$public/manifest.webmanifest" <<EOF
{
  "name": "$name",
  "short_name": "$name",
  "description": "$description",
  "id": "./",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "$background",
  "theme_color": "$background",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    {
      "src": "icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
EOF
}

styles="$root/packages/ui/src/styles"
app_icons movies "Lar Movies" "Your movies and shows, streamed from your own library" \
  "$(token "$styles/globals.css" dark-bg)"
app_icons music "Lar Music" "Your own music library, streamed from your server" \
  "$(token "$styles/music.css" dark-bg)"

echo "brand-icons: wrote the web clients' and iOS apps' icons from brand/"
