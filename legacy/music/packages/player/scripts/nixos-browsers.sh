#!/usr/bin/env bash
# Runs a command with the libraries Playwright's Firefox and WebKit builds need on NixOS (through
# nix-ld) and the GStreamer plugins WebKit plays media with, for example:
#
#   packages/player/scripts/nixos-browsers.sh pnpm --filter @music/player test:browser
#
# Needs nix-ld enabled (programs.nix-ld.enable) and flakes. Chromium uses CHROMIUM_PATH instead.
set -euo pipefail

expr='
let
  pkgs = import (builtins.getFlake "nixpkgs").outPath { system = builtins.currentSystem; };
  gst = with pkgs.gst_all_1; [ gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav ];
in {
  libraries = pkgs.lib.makeLibraryPath (with pkgs; [
    alsa-lib atk at-spi2-atk at-spi2-core cairo dbus expat fontconfig freetype gdk-pixbuf glib
    gtk3 gtk4 harfbuzz harfbuzzFull libdrm libgbm libxkbcommon mesa nspr nss pango zlib libffi
    stdenv.cc.cc libpulseaudio pipewire ffmpeg_7
    libx11 libxcb libxcomposite libxcursor libxdamage libxext libxfixes libxi libxrandr
    libxrender libxtst libxshmfence
    libsoup_3 libsecret libgcrypt libgpg-error libwebp libavif woff2 libmanette libjpeg8 libpng
    libepoxy enchant hyphen libnotify libtasn1 libxslt libxml2_13 sqlite icu74 lcms2 openjpeg
    libevdev libgudev systemd wayland libopus libvpx flite libseccomp graphene libjxl gnutls
    libtiff libevent libpsl nghttp2 orc libwpe libwpe-fdo libinput mtdev
  ] ++ gst);
  plugins = pkgs.lib.concatMapStringsSep ":" (p: "${pkgs.lib.getLib p}/lib/gstreamer-1.0") gst;
}'

libraries="$(nix eval --impure --raw --expr "(${expr}).libraries")"
plugins="$(nix eval --impure --raw --expr "(${expr}).plugins")"

export NIX_LD_LIBRARY_PATH="${libraries}${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
export GST_PLUGIN_SYSTEM_PATH_1_0="${plugins}"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export CHROMIUM_PATH="${CHROMIUM_PATH:-$(command -v chromium || true)}"

exec "$@"
