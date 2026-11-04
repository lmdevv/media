#!/usr/bin/env bash
# Tiles screenshots into one PNG, each scaled to WIDTH and captioned with its file name, so a matrix
# of sizes and orientations reads at a glance and goes on a PR as one image.
#
#   contact-sheet.sh OUT.png COLUMNS WIDTH FILE...
set -euo pipefail
(($# >= 4)) || { sed -n '5p' "$0" >&2; exit 2; }
out="$1" cols="$2" width="$3"
shift 3
font="$(fc-match -f '%{file}' sans)"
files=("$@") args=() filter="" inputs="" layout=""
for i in "${!files[@]}"; do
  label="$(basename "${files[$i]}" .png | tr -c 'A-Za-z0-9.\n-' '-')"
  args+=(-i "${files[$i]}")
  filter+="[$i:v]scale=$width:-1,pad=$width:ih+28:0:28:color=0x333333,drawtext=fontfile=$font:text=$label:x=6:y=5:fontsize=18:fontcolor=white[v$i];"
  inputs+="[v$i]"
  # xstack places each tile after the widths left of it and the heights of the tiles above it.
  col=$((i % cols)) row=$((i / cols)) x=0 y=0
  ((col > 0)) && x="$(for _ in $(seq 1 "$col"); do printf 'w0+'; done | sed 's/+$//')"
  ((row > 0)) && y="$(for k in $(seq 0 $((row - 1))); do printf 'h%d+' $((k * cols + col)); done | sed 's/+$//')"
  layout+="${x}_${y}|"
done
# xstack takes two inputs or more; one file is only scaled and captioned.
if ((${#files[@]} == 1)); then
  ffmpeg -loglevel error -y "${args[@]}" -filter_complex "${filter%;}" -map "[v0]" -frames:v 1 "$out"
else
  ffmpeg -loglevel error -y "${args[@]}" \
    -filter_complex "${filter}${inputs}xstack=inputs=${#files[@]}:layout=${layout%|}:fill=black" -frames:v 1 "$out"
fi
echo "$out"
