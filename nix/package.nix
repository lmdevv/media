# [movies] built from this repository: the media service bundle, the web app (built once with a
# placeholder Convex URL that `movies-configure-web` replaces at startup), and the Convex
# functions with production dependencies and the pinned Convex CLI.
#
#   nix build .#movies
#
# After a change to pnpm-lock.yaml, set `pnpmDeps.hash` to "" and build once; Nix prints the
# new hash.
{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs_24,
  ffmpeg-full,
  makeWrapper,
}:
let
  root = ../.;
  pnpm = pnpm_12;
  nodejs = nodejs_24;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "movies";
  version = (lib.importJSON ../packages/backend/package.json).version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.intersection (lib.fileset.gitTracked root) (
      lib.fileset.unions [
        ../package.json
        ../pnpm-lock.yaml
        ../pnpm-workspace.yaml
        ../tsconfig.json
        ../apps
        ../packages
        ../deploy/functions-hash.sh
      ]
    );
  };

  pnpmWorkspaces = [
    "web..."
    "@media/server..."
    "@media/backend..."
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-gMPtbUVcdEukyhCYo04fRrXeQ4s5o+jDnacuTULRQiY=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild

    VITE_CONVEX_URL=__MEDIA_CONVEX_URL__ pnpm --filter web build
    pnpm --filter @media/server build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    lib=$out/lib/movies
    mkdir -p $lib/media/scripts $out/bin

    # The functions' tsconfig extends the shared config, which `convex deploy` reads.
    pnpm --filter @media/backend --config.inject-workspace-packages=true deploy --prod --offline $lib/backend
    rm -rf $lib/backend/test
    mkdir -p $lib/backend/node_modules/@media
    cp -r packages/config $lib/backend/node_modules/@media/config
    sh deploy/functions-hash.sh $lib/backend >$lib/backend/.functions-hash

    cp -r apps/media/dist $lib/media/dist
    cp apps/media/scripts/configure-web.ts $lib/media/scripts/
    cp -r apps/web/dist $lib/web

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-media \
      --add-flags "--enable-source-maps $lib/media/dist/main.js" \
      --set-default FFMPEG_PATH ${lib.getExe' ffmpeg-full "ffmpeg"} \
      --set-default FFPROBE_PATH ${lib.getExe' ffmpeg-full "ffprobe"} \
      --set-default CONVEX_BACKEND_DIR $lib/backend

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure-web \
      --add-flags "$lib/media/scripts/configure-web.ts --from $lib/web"

    # The Convex CLI reads the backend's package.json, so both run from its folder.
    makeWrapper ${lib.getExe nodejs} $out/bin/movies-convex \
      --chdir $lib/backend \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/backend/node_modules/convex/bin/main.js"

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure \
      --chdir $lib/backend \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/backend/scripts/configure.ts"

    runHook postInstall
  '';

  passthru = { inherit nodejs; };

  meta = {
    description = "Self-hosted movies and TV for people and agents";
    homepage = "https://github.com/lmdevv/media";
    license = lib.licenses.mit;
    mainProgram = "movies-media";
    platforms = lib.platforms.linux;
  };
})
