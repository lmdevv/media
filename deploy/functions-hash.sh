#!/bin/sh
# Prints a short hash of what a deployed @media/backend sends to Convex: the functions and schema
# (convex/) and the version of every dependency bundled with them (each package.json). The image
# and the Nix package write it to .functions-hash; the installs record it with the release, so any
# build whose functions differ backs up before it deploys.
#
#   deploy/functions-hash.sh /app/backend
set -eu
cd "$1"
find convex package.json node_modules -type f \( -path 'convex/*' -o -name package.json \) -print0 |
  LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
