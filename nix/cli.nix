# The `media` CLI, bundled by esbuild into one file and run with Node.
#
#   nix run github:lmdevv/media#cli -- login --server http://nas.tailnet.ts.net:3210
#
# Dependencies come from pnpm-lock.yaml through fetchPnpmDeps. When the lockfile changes,
# `scripts/check-pnpm-deps-hash.sh --write` updates `hash` below.
{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
}:
let
  packageJson = lib.importJSON ../apps/cli/package.json;

  # pnpm checks the lockfile against every workspace's package.json, so all of them come along.
  # The tsconfigs give esbuild the same compiler settings as the workspace build.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      (lib.fileset.fileFilter (file: file.name == "package.json") ../apps)
      (lib.fileset.fileFilter (file: file.name == "package.json") ../packages)
      ../apps/cli/src
      ../apps/cli/scripts
      ../apps/cli/tsconfig.json
      ../packages/contracts/src
      ../packages/contracts/tsconfig.json
      ../packages/sdk/src
      ../packages/sdk/tsconfig.json
      ../packages/config
    ];
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "movies-cli";
  inherit (packageJson) version;
  inherit src;

  pnpmWorkspaces = [ "@lmdevv/movies..." ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash = "sha256-e0/27gzU1OvdPN6WZq89vKL/Sy6dWkHn2UkqsFuCB7w=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild
    pnpm --filter @lmdevv/movies build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 apps/cli/dist/media.js "$out/lib/media/media.mjs"
    install -Dm644 apps/cli/dist/THIRD_PARTY_LICENSES.md -t "$out/share/doc/movies-cli"
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/media" --add-flags "$out/lib/media/media.mjs"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    [ "$("$out/bin/media" --version)" = "${finalAttrs.version}" ]
    "$out/bin/media" --help | grep -q "Usage: media"
    runHook postInstallCheck
  '';

  meta = {
    description = "The [movies] command line: every command of a self-hosted [movies] server";
    homepage = "https://github.com/lmdevv/media";
    license = lib.licenses.mit;
    mainProgram = "media";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
