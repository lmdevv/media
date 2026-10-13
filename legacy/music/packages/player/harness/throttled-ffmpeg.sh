#!/usr/bin/env bash
# The media stub's ffmpeg. While the file named by MUSIC_STUB_READRATE_FILE exists, ffmpeg reads
# its input no faster than the rate in it (times real time), so a transcode stays live long
# enough for a test to seek into it (`POST /control/slow`).
set -euo pipefail

rate_file="${MUSIC_STUB_READRATE_FILE:-}"

if [[ -n "$rate_file" && -f "$rate_file" ]]; then
  exec ffmpeg -readrate "$(<"$rate_file")" "$@"
fi

exec ffmpeg "$@"
