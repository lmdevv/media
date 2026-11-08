#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

failures=0
fail() {
  echo "check-deploy: $*" >&2
  failures=$((failures + 1))
}

pinned="$(<deploy/convex-backend.image)"
if ! [[ "$pinned" =~ ^ghcr\.io/convex/convex-backend:[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
  fail "deploy/convex-backend.image must hold one image reference with a digest; got '$pinned'"
fi

dockerfile_image="$(sed -n 's/^ARG CONVEX_IMAGE=//p' deploy/image/Dockerfile)"
[[ "$dockerfile_image" == "$pinned" ]] ||
  fail "deploy/image/Dockerfile copies the Convex backend from '$dockerfile_image', not '$pinned'"

grep -qF 'deploy/convex-backend.image' scripts/dev-stack.sh ||
  fail "scripts/dev-stack.sh no longer reads deploy/convex-backend.image"
grep -qF '../deploy/convex-backend.image' nix/module.nix ||
  fail "nix/module.nix no longer reads deploy/convex-backend.image"

config_source="$(tr '\n' ' ' <apps/media/src/media-config.ts)"
mapfile -t config_names < <(
  grep -oE 'Config\.[A-Za-z]+\([^()]*"[A-Z][A-Z0-9_]+"' <<<"$config_source" |
    grep -oE '"[A-Z][A-Z0-9_]+"' | tr -d '"' | sort -u
)
config_reads="$(grep -oE 'yield\* Config\.' <<<"$config_source" | wc -l)"
((${#config_names[@]} == config_reads)) ||
  fail "parsed ${#config_names[@]} setting names but media-config.ts has $config_reads Config reads"

init=deploy/image/rootfs/app/bin/init
mapfile -t entrypoint_set < <(sed -n 's/^setting \([A-Z][A-Z0-9_]*\) .*/\1/p' "$init" | sort -u)
mapfile -t entrypoint_forwarded < <(
  sed -n '/^optional_settings=(/,/^)/p' "$init" | grep -oE '^ +[A-Z][A-Z0-9_]+' |
    tr -d ' ' | sort -u
)
((${#entrypoint_forwarded[@]} > 0)) || fail "found no optional_settings in $init"
image_fixed=(FFMPEG_PATH FFPROBE_PATH)

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

for name in "${config_names[@]}"; do
  if ! contains "$name" "${entrypoint_set[@]}" "${entrypoint_forwarded[@]}" "${image_fixed[@]}"; then
    fail "$name (media-config.ts) is neither set nor passed on by $init"
  fi
  grep -qE "^ +${name} = |'${name}=%s" nix/module.nix || fail "$name (media-config.ts) is not set by nix/module.nix"
  grep -qF "\`${name}\`" apps/media/README.md || fail "$name (media-config.ts) is not in apps/media/README.md"
done

user_facing=(LIBRARY_ROOTS "${entrypoint_forwarded[@]}")
for name in "${user_facing[@]}"; do
  grep -qE "^      ${name}: \\$\\{${name}:-\\}$" deploy/compose/compose.yaml ||
    fail "$name is passed on by init but compose.yaml lacks '${name}: \${${name}:-}'"
  grep -qE "^${name}=" deploy/compose/.env.example || fail "$name is not in deploy/compose/.env.example"
  grep -qE "^${name}=" .env.example || fail "$name is not in .env.example"
  grep -qF "\`${name}\`" README.md || fail "$name is not in README.md's configuration table"
done

mapfile -t jellyfin_refs < <(
  git ls-files -z -- ':!*.md' ':!legacy' |
    xargs -0 grep -ohE 'jellyfin/jellyfin:[0-9][0-9.]*(@sha256:[0-9a-f]{64})?' 2>/dev/null | sort -u
)
((${#jellyfin_refs[@]} > 0)) || fail "found no Jellyfin test image reference"
for ref in "${jellyfin_refs[@]}"; do
  [[ "$ref" == *@sha256:* ]] || fail "the Jellyfin test image '$ref' is not pinned by digest"
done
((${#jellyfin_refs[@]} <= 1)) || fail "the Jellyfin test image is referenced as: ${jellyfin_refs[*]}"

scripts/check-version.sh >/dev/null || fail "the workspace packages disagree on the release version"

demo_library="$(<deploy/demo-library/image)"
[[ "$(sed -n 's/^ *source: \(ghcr\.io\/lmdevv\/media-demo-library:.*\)$/\1/p' deploy/compose/compose.demo.yaml)" == "$demo_library" ]] ||
  fail "compose.demo.yaml does not mount deploy/demo-library/image ('$demo_library')"

if ((failures > 0)); then
  exit 1
fi
echo "check-deploy: ok (${#config_names[@]} media settings, Convex backend $pinned)"
