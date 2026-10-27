# The `music` CLI, bundled by esbuild into one file and run with Node.
#
#   nix run github:lmdevv/music#cli -- login --server https://music.example.com/convex
#
# Dependencies come from pnpm-lock.yaml through fetchPnpmDeps. When the lockfile changes, update
# `hash` below: set it to "" and copy the hash from the error `nix build .#cli` prints.
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

  # pnpm checks the lockfile against every workspace's package.json, so all of them come along;
  # sources only for the CLI and the workspace packages it bundles.
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
      ../packages/commands/src
      ../packages/sdk/src
      ../packages/config
    ];
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "music-cli";
  inherit (packageJson) version;
  inherit src;

  pnpmWorkspaces = [ "@music/cli..." ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash = "sha256-cGTr9QSLP2Y2bAKr9stu4yyd5AR5GKe0kwBfw+VW1hw=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild
    pnpm --filter @music/cli build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 apps/cli/dist/music.js "$out/lib/music/music.js"
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/music" --add-flags "$out/lib/music/music.js"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    [ "$("$out/bin/music" --version)" = "${finalAttrs.version}" ]
    "$out/bin/music" --help | grep -q "Usage: music"
    runHook postInstallCheck
  '';

  meta = {
    description = "The [music] command line: every command of a self-hosted [music] server";
    homepage = "https://github.com/lmdevv/music";
    license = lib.licenses.mit;
    mainProgram = "music";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
