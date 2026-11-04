#!/usr/bin/env bash
# Points the moving image tags at the image CI just pushed as `sha-<commit>`, but only forwards:
#
#   - a branch push moves the branch's tag (`main`) only if the commit is still the branch head;
#   - a release tag `vX.Y.Z` moves `X.Y` only if it is the newest release in that series, and
#     `latest` only if it is the newest release of all. Pre-releases move nothing.
#
# Runs at the end of CI's publish job, after the build, so a run that finishes after a newer one
# leaves the newer tags alone. Env: IMAGE (ghcr.io/owner/repo), REMOTE (the repository URL),
# GITHUB_REF, GITHUB_SHA; DRY_RUN=1 prints instead of tagging. RELEASES overrides the release
# versions read from REMOTE (one X.Y.Z per line), and HEAD the branch head, for testing.
set -euo pipefail

source="$IMAGE:sha-${GITHUB_SHA::7}"

move() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "would move $1 to $GITHUB_SHA"
  else
    docker buildx imagetools create -t "$IMAGE:$1" "$source"
    echo "moved $1 to $GITHUB_SHA"
  fi
}

skip() { echo "::notice::$*"; }

case "$GITHUB_REF" in
  refs/heads/*)
    branch="${GITHUB_REF#refs/heads/}"
    head="${HEAD:-$(git ls-remote "$REMOTE" "refs/heads/$branch" | cut -f1)}"
    if [[ "$head" == "$GITHUB_SHA" ]]; then
      move "$branch"
    else
      skip "$branch is now at $head; not moving the $branch tag back to $GITHUB_SHA"
    fi
    ;;
  refs/tags/v*)
    version="${GITHUB_REF#refs/tags/v}"
    if [[ "$version" == *-* ]]; then
      skip "$version is a pre-release; not moving latest or its series"
      exit 0
    fi
    releases="${RELEASES:-$(git ls-remote --tags "$REMOTE" 'refs/tags/v*' |
      sed -n 's|.*refs/tags/v\([0-9]*\.[0-9]*\.[0-9]*\)$|\1|p')}"
    releases="$(sort -V <<<"$releases")"
    series="${version%.*}"
    newest_in_series="$(awk -F. -v series="$series" '$1"."$2 == series' <<<"$releases" | tail -n 1)"
    newest="$(tail -n 1 <<<"$releases")"
    if [[ "$version" == "$newest_in_series" ]]; then
      move "$series"
    else
      skip "$newest_in_series is newer than $version; not moving $series"
    fi
    if [[ "$version" == "$newest" ]]; then
      move latest
    else
      skip "$newest is newer than $version; not moving latest"
    fi
    ;;
  *)
    skip "nothing to move for $GITHUB_REF"
    ;;
esac
