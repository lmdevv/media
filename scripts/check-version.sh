#!/usr/bin/env bash
# Prints the release version and fails unless every workspace package and each iOS app's
# `expo.version` in its app.json carries it: the image, the Nix packages, the npm package, the release
# binaries, and the iOS apps all report it. Given a release tag, also fails unless the tag names that
# version.
#
#   scripts/check-version.sh            # 0.5.0
#   scripts/check-version.sh v0.5.0     # the release workflows, with the pushed tag
set -euo pipefail

cd "$(dirname "$0")/.."

# A command substitution, so a git failure stops the script instead of checking nothing.
tracked="$(git ls-files -- ':(glob)apps/**/package.json' ':(glob)packages/**/package.json' ':(glob)apps/**/app.json')"
mapfile -t manifests <<<"$tracked"

node - "${1:-}" "${manifests[@]}" <<'EOF'
const { readFileSync } = require("node:fs");

const [tag, ...manifests] = process.argv.slice(2);
const versionOf = (path) => {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return path.endsWith("/app.json") ? manifest.expo.version : manifest.version;
};
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
