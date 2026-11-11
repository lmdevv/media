#!/usr/bin/env bash
# Checks that the pnpm dependency hashes nix/package.nix and nix/cli.nix pin still match
# pnpm-lock.yaml, which CI's Nix job otherwise finds only after a push. Nix keeps the output of a
# hash it already has, so each package's dependencies are fetched again under a placeholder hash.
#
#   scripts/check-pnpm-deps-hash.sh          fail with the hashes to pin
#   scripts/check-pnpm-deps-hash.sh --write  pin them
#
# It needs Nix on Linux, where both packages build, and skips elsewhere or when it cannot reach the
# npm registry or the Nix cache. CI's Nix job checks the hashes either way. Any other failure fails.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

write=false
case "${1:-}" in
  "") ;;
  --write) write=true ;;
  *)
    echo "usage: scripts/check-pnpm-deps-hash.sh [--write]" >&2
    exit 2
    ;;
esac

if [[ "$(uname -s)" != Linux ]] || ! command -v nix >/dev/null; then
  echo "check-pnpm-deps-hash: skipped, needs Nix on Linux" >&2
  exit 0
fi

if command -v curl >/dev/null; then
  for url in https://registry.npmjs.org/ https://cache.nixos.org/nix-cache-info; do
    if ! curl -fsS -o /dev/null --max-time 10 "$url" 2>/dev/null; then
      echo "check-pnpm-deps-hash: skipped, cannot reach $url" >&2
      exit 0
    fi
  done
fi

system="$(nix eval --impure --raw --expr builtins.currentSystem)"
logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

declare -A files=([movies]=nix/package.nix [cli]=nix/cli.nix)

for package in "${!files[@]}"; do
  nix build --impure --no-link --expr "
    (builtins.getFlake \"git+file://$root\").packages.$system.$package.pnpmDeps.overrideAttrs {
      outputHash = \"\";
      outputHashAlgo = \"sha256\";
    }" >"$logs/$package" 2>&1 &
done
wait

failures=0
stale=0
for package in "${!files[@]}"; do
  file="${files[$package]}"
  pinned="$(sed -n 's/^ *hash = "\(sha256-[^"]*\)";$/\1/p' "$file")"
  actual="$(sed -n 's/^ *got: *\(sha256-[^ ]*\)$/\1/p' "$logs/$package")"

  if [[ ! "$pinned" =~ ^sha256-[^[:space:]]+$ ]]; then
    echo "check-pnpm-deps-hash: $file must pin exactly one hash = \"sha256-...\";" >&2
    failures=$((failures + 1))
  elif [[ -z "$actual" ]]; then
    echo "check-pnpm-deps-hash: found no hash in Nix's output for $package:" >&2
    tail -20 "$logs/$package" >&2
    failures=$((failures + 1))
  elif [[ "$actual" != "$pinned" ]]; then
    if $write; then
      sed -i "s|hash = \"$pinned\";|hash = \"$actual\";|" "$file"
      echo "check-pnpm-deps-hash: pinned $actual in $file"
    else
      echo "check-pnpm-deps-hash: $file pins $pinned; pnpm-lock.yaml needs $actual" >&2
      failures=$((failures + 1))
      stale=$((stale + 1))
    fi
  fi
done

if ((stale > 0)); then
  echo "check-pnpm-deps-hash: run scripts/check-pnpm-deps-hash.sh --write" >&2
fi
if ((failures > 0)); then
  exit 1
fi
