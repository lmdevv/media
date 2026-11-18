#!/usr/bin/env bash
# Finds text that explains the code by its history: the old [movies] and [music] products, their
# releases, ports and cutover, and plan step names. Prints each match and exits 1 when any is
# found, 0 when none is.
#
#   scripts/check-history.sh <path>...
#
# Decision records (docs/decisions/, docs/decisions.md), node_modules, generated Convex code,
# .git, the .repos reference clones, and this script are always skipped.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/check-history.sh <path>..." >&2
  exit 2
fi

pattern='old (movies|music)|\[(movies|music)\] v0\.|\bv0\.[23]\b|\b0\.3\.0\b|\b0\.4\.0\b|cutover|(movies|music) port|\bp[0-9]-[a-z]+-[a-z-]+|earlier naming|from before|before .* was kept'
skipped='^([^:]*/)?(docs/decisions/|docs/decisions\.md:|node_modules/|convex/_generated/|\.git/|\.repos/|scripts/check-history\.sh:)'

status=0
matches="$(
  grep -rHnIiE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.repos -- "$pattern" "$@" ||
    status=$?
  [[ $status -le 1 ]] || exit "$status"
)"
matches="$(grep -vE "$skipped" <<<"$matches" || true)"

if [[ -n "$matches" ]]; then
  printf '%s\n' "$matches"
  echo "check-history: $(wc -l <<<"$matches") lines explain the code by its history" >&2
  exit 1
fi
