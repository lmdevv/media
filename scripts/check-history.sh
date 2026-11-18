#!/usr/bin/env bash
# Finds text that explains the code by its history: the old [movies] and [music] products, their
# releases, ports and cutover, and plan step names. Prints each match and exits 1 when any is
# found, 0 when none is.
#
#   scripts/check-history.sh <path>...
#
# For a path inside this checkout it reads the files git tracks or would track, so build output
# and other ignored files are never searched. For any other path it reads every file. A symlink is
# skipped for its target.
#
# Decision records (docs/decisions/, docs/decisions.md), node_modules, generated Convex code,
# .git, the .repos reference clones, and this script are always skipped.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/check-history.sh <path>..." >&2
  exit 2
fi

pattern='\bold (movies|music)|\[(movies|music)\] v0\.|\bv0\.[23]\b|\b0\.3\.0\b|\b0\.4\.0\b|cutover|(movies|music) port|\bp[0-9]-[a-z]+-[a-z-]+|earlier naming|from before|before .* was kept'
skipped='^([^:]*/)?(docs/decisions/|docs/decisions\.md:|node_modules/|convex/_generated/|\.git/|\.repos/|scripts/check-history\.sh:)'

files="$(mktemp)"
trap 'rm -f "$files"' EXIT

for path in "$@"; do
  [[ -e "$path" ]] || {
    echo "check-history: $path: no such file or directory" >&2
    exit 2
  }
  git ls-files -z --cached --others --exclude-standard -- "$path" >>"$files" 2>/dev/null ||
    find "$path" \( -name node_modules -o -name .git -o -name .repos \) -prune -o -type f -print0 >>"$files"
done

matches="$(
  while IFS= read -r -d '' file; do
    [[ -f "$file" && ! -L "$file" ]] && printf '%s\0' "$file"
  done <"$files" |
    sort -zu |
    { xargs -0 -r grep -HnIiE -- "$pattern" || [[ $? -eq 123 ]]; }
)"
matches="$(grep -vE "$skipped" <<<"$matches" || true)"

if [[ -n "$matches" ]]; then
  printf '%s\n' "$matches"
  echo "check-history: $(wc -l <<<"$matches") lines explain the code by its history" >&2
  exit 1
fi
