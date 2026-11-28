#!/usr/bin/env bash
# Checks each tracked path and each of its parent folders for case collisions.
#
#   scripts/check-path-case.sh    # read git ls-files -z
#   scripts/check-path-case.sh -  # read NUL-delimited paths from stdin
#
# Case-insensitive APFS uses Unicode case folding and normalization. This check folds ASCII A-Z
# to a-z and rejects every non-ASCII path component, including invalid UTF-8, because it cannot
# establish APFS equivalence for those names. It prints each colliding group and exits 1 on any
# collision or unsupported name. Success is silent.
set -euo pipefail

check_paths() {
  node -e '
    const { readFileSync } = require("node:fs");

    // Latin-1 keeps each input byte intact, even for invalid UTF-8.
    const paths = readFileSync(0, "latin1").split("\0");
    const groups = new Map();
    const unsupported = new Set();

    for (const path of paths) {
      if (path === "") continue;
      let prefix = "";
      for (const component of path.split("/")) {
        prefix = prefix === "" ? component : `${prefix}/${component}`;
        if (/[^\x00-\x7f]/u.test(component)) {
          unsupported.add(prefix);
          break;
        }
        const key = prefix.toLowerCase();
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(prefix);
      }
    }

    const quote = (path) => JSON.stringify(path).replace(/[^\x20-\x7e]/gu, (byte) =>
      `\\u${byte.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

    for (const spellings of groups.values()) {
      if (spellings.size < 2) continue;
      console.log(`check-path-case: ${[...spellings].sort().map(quote).join(", ")}`);
      process.exitCode = 1;
    }
    for (const prefix of unsupported) {
      console.error(`check-path-case: ${quote(prefix)} contains non-ASCII bytes`);
      process.exitCode = 1;
    }
  '
}

if [[ $# -eq 0 ]]; then
  git -C "$(dirname "$0")/.." ls-files -z | check_paths
elif [[ $# -eq 1 && "$1" == - ]]; then
  check_paths
else
  echo "usage: scripts/check-path-case.sh [-]" >&2
  exit 2
fi
