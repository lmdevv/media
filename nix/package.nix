# [media] built from this repository: the media service bundle, the movies client (served at
# /movies) and the account client, each built once with a placeholder Convex URL that
# `movies-configure-web` replaces at startup, and both Convex projects (old movies and the core)
# with production dependencies and the pinned Convex CLI.
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
        ../deploy/image/rootfs/etc/caddy/Caddyfile
      ]
    );
  };

  pnpmWorkspaces = [
    "web..."
    "@media/web-account..."
    "@media/server..."
    "@media/backend..."
    "@media/platform..."
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
    hash = "sha256-DdJM9VC8wlcy9Je6zFJ9cxBJM4bnyaeGCIpHVJYXpnY=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild

    VITE_CONVEX_URL=__MEDIA_CONVEX_URL__ pnpm --filter web build --base=/movies/
    VITE_PLATFORM_URL=__MEDIA_CONVEX_URL__ pnpm --filter @media/web-account build
    pnpm --filter @media/server build
    # The core's configure script imports TypeScript from a workspace package, which Node does not
    # strip inside node_modules, so it ships bundled.
    pnpm --filter @media/server exec esbuild ../../packages/platform/scripts/configure.ts \
      --bundle --platform=node --format=esm --target=node24 --log-level=warning \
      --outfile=../../packages/platform/scripts/configure.mjs

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    lib=$out/lib/movies
    mkdir -p $lib/media/scripts $out/bin

    # Each project's tsconfig extends the shared config, which `convex deploy` reads.
    for project in backend platform; do
      pnpm --filter "@media/$project" --config.inject-workspace-packages=true deploy --prod --offline "$lib/$project"
      rm -rf "$lib/$project/test"
      mkdir -p "$lib/$project/node_modules/@media"
      cp -r packages/config "$lib/$project/node_modules/@media/config"
      sh deploy/functions-hash.sh "$lib/$project" >"$lib/$project/.functions-hash"
    done
    cp packages/platform/scripts/configure.mjs $lib/platform/scripts/
    rm $lib/platform/scripts/configure.ts
    install -D -m 644 deploy/image/rootfs/etc/caddy/Caddyfile $lib/Caddyfile

    cp -r apps/media/dist $lib/media/dist
    cp apps/media/scripts/configure-web.ts $lib/media/scripts/
    cp -r apps/web/dist $lib/web
    cp -r apps/web-account/dist $lib/account

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-media \
      --add-flags "--enable-source-maps $lib/media/dist/main.js" \
      --set-default FFMPEG_PATH ${lib.getExe' ffmpeg-full "ffmpeg"} \
      --set-default FFPROBE_PATH ${lib.getExe' ffmpeg-full "ffprobe"} \
      --set-default CONVEX_BACKEND_DIR $lib/backend

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure-web \
      --add-flags "$lib/media/scripts/configure-web.ts --from $lib/web"

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure-account \
      --add-flags "$lib/media/scripts/configure-web.ts --from $lib/account"

    # The Convex CLI reads the backend's package.json, so both run from its folder.
    makeWrapper ${lib.getExe nodejs} $out/bin/movies-convex \
      --chdir $lib/backend \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/backend/node_modules/convex/bin/main.js"

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure \
      --chdir $lib/backend \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/backend/scripts/configure.ts"

    makeWrapper ${lib.getExe nodejs} $out/bin/media-core-convex \
      --chdir $lib/platform \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/platform/node_modules/convex/bin/main.js"

    makeWrapper ${lib.getExe nodejs} $out/bin/media-core-configure \
      --chdir $lib/platform \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --add-flags "$lib/platform/scripts/configure.mjs"

    runHook postInstall
  '';

  passthru = { inherit nodejs; };

  meta = {
    description = "Self-hosted media for people and agents: the account client and movies";
    homepage = "https://github.com/lmdevv/media";
    license = lib.licenses.mit;
    mainProgram = "movies-media";
    platforms = lib.platforms.linux;
  };
})
