#!/usr/bin/env bash
set -euo pipefail

rate_file="${MUSIC_STUB_READRATE_FILE:-}"

if [[ -n "$rate_file" && -f "$rate_file" ]]; then
  exec ffmpeg -readrate "$(<"$rate_file")" "$@"
fi

exec ffmpeg "$@"
