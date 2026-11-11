#!/usr/bin/env bash
# Draws the [movies] mark and writes the web app's favicons, app icons and manifest into
# apps/web-movies/public. Colors come from the Paper tokens in packages/ui/src/styles/globals.css, so rerun
# this after the tokens change and commit the outputs.
#
# Needs ImageMagick 7 with its librsvg delegate; without `magick` on PATH it reruns itself in a
# `nix shell` with the repo flake's pinned nixpkgs.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v magick >/dev/null; then
  exec nix shell --inputs-from "$root" nixpkgs#imagemagick --command "$0" "$@"
fi

tokens="$root/packages/ui/src/styles/globals.css"
public="$root/apps/web-movies/public"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

token() {
  local value
  value="$(sed -n "s/^ *--color-$1: *\(#[0-9a-fA-F]\{6\}\);.*/\1/p" "$tokens" | head -n 1)"

  if [[ -z "$value" ]]; then
    echo "app-icons: no hex value for --color-$1 in $tokens" >&2
    exit 1
  fi

  printf '%s' "$value"
}

accent="$(token accent)"
dark_bg="$(token dark-bg)"

large_mark() {
  cat <<EOF
<g fill="none" stroke="$accent" stroke-width="6">
  <path d="M16 7H6v50h10M48 7h10v50H48"/>
  <path d="M22 50V22M22 33c0-6 2.5-8.5 5-8.5s5 2.5 5 8.5v17M32 33c0-6 2.5-8.5 5-8.5s5 2.5 5 8.5v17"/>
</g>
EOF
}

app_icon() {
  local scale="$1" radius="$2"
  local offset
  offset="$(awk -v s="$scale" 'BEGIN { printf "%.4f", 32 * (1 - s) / s }')"

  cat <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="$(awk -v r="$radius" 'BEGIN { print 64 * r }')" fill="$dark_bg"/>
  <g transform="scale($scale) translate($offset $offset)">
$(large_mark)
  </g>
</svg>
EOF
}

cat >"$public/favicon.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <path fill="$accent" d="M1 1h3v1H2v12h2v1H1zM14 1h-3v1h2v12h-2v1h3zM5 6h4v1H8v7H7V7H6v7H5zM9 7h1v7H9z"/>
</svg>
EOF

# Renders `svg` to a `size`-pixel square PNG without metadata, so reruns write identical files.
render() {
  local svg="$1" size="$2" out="$3"
  magick -background none -density "$((96 * size / 16))" "$svg" -resize "${size}x${size}" \
    -depth 8 -strip -define png:exclude-chunks=date,time "$out"
}

for size in 16 32 48; do
  render "$public/favicon.svg" "$size" "$work/favicon-$size.png"
done

magick "$work/favicon-16.png" "$work/favicon-32.png" "$work/favicon-48.png" "$public/favicon.ico"

# Launchers that keep the icon's own shape get a rounded square; iOS and maskable icons are
# full-bleed squares the platform masks. A maskable icon keeps the mark inside the central circle
# of 80% diameter that every mask preserves.
app_icon 0.62 0.22 >"$work/icon.svg"
app_icon 0.62 0 >"$work/touch.svg"
app_icon 0.5 0 >"$work/maskable.svg"

render "$work/icon.svg" 192 "$public/icon-192.png"
render "$work/icon.svg" 512 "$public/icon-512.png"
render "$work/maskable.svg" 512 "$public/icon-maskable-512.png"
render "$work/touch.svg" 180 "$public/apple-touch-icon.png"

cat >"$public/manifest.webmanifest" <<EOF
{
  "name": "[movies]",
  "short_name": "[movies]",
  "description": "Your movies and shows, streamed from your own library",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "$dark_bg",
  "theme_color": "$dark_bg",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    {
      "src": "/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
EOF

echo "app-icons: wrote favicons, app icons and manifest.webmanifest to apps/web-movies/public"
