#!/usr/bin/env bash
# Prints the release version and fails unless every workspace package carries it: the image, the
# Nix packages, the npm package, and the release binaries all report it. Given a release tag, also
# fails unless the tag names that version. The iOS app's store version (`expo.version` in
# apps/mobile-movies/app.json) goes through App Store review on its own schedule, so it is not checked.
#
#   scripts/check-version.sh            # 0.2.0
#   scripts/check-version.sh v0.2.0     # the release workflows, with the pushed tag
set -euo pipefail

cd "$(dirname "$0")/.."

# A command substitution, so a git failure stops the script instead of checking nothing.
tracked="$(git ls-files -- ':(glob)apps/*/package.json' ':(glob)packages/*/package.json')"
mapfile -t manifests <<<"$tracked"

node - "${1:-}" "${manifests[@]}" <<'EOF'
const { readFileSync } = require("node:fs");

const [tag, ...manifests] = process.argv.slice(2);
const versionOf = (path) => JSON.parse(readFileSync(path, "utf8")).version;
const version = versionOf("packages/platform/package.json");
const failures = manifests
  .filter((path) => versionOf(path) !== version)
  .map((path) => `${path} is ${versionOf(path)}, not ${version} (packages/platform/package.json)`);

if (tag !== "" && tag !== `v${version}`) {
  failures.push(`tag ${tag} does not name the package version ${version}`);
}

for (const failure of failures) console.error(`check-version: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(version);
EOF
