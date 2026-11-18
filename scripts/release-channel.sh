#!/usr/bin/env bash
# Prints where a release version publishes, from the repository's `v*` tags:
#
# - `next` for a pre-release (`0.5.0-rc.1`), which never becomes the latest release;
# - `latest` for the highest stable version tagged;
# - `release-X.Y` for a backport to an older line (`0.4.2` once `v0.5.0` exists).
#
# The release workflow uses it as the npm dist-tag, and marks the GitHub Release latest only for
# `latest`. It needs the tags fetched.
#
#   scripts/release-channel.sh 0.2.0     # latest
set -euo pipefail

version="${1:?usage: scripts/release-channel.sh <version>}"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
  echo "release-channel: $version is not a release version" >&2
  exit 1
fi

if [[ "$version" == *-* ]]; then
  echo next
  exit 0
fi

highest="$(
  { git -C "$(dirname "$0")/.." tag --list 'v*' | sed 's/^v//'; echo "$version"; } |
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
)"

if [[ "$highest" == "$version" ]]; then
  echo latest
else
  echo "release-${version%.*}"
fi
