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
  version = (lib.importJSON ../packages/platform/package.json).version;

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
    "@media/web-movies..."
    "@media/web-account..."
    "@media/server..."
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

    VITE_PLATFORM_URL=__MEDIA_CONVEX_URL__ pnpm --filter @media/web-movies build --base=/movies/
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

    # The core's tsconfig extends the shared config, which `convex deploy` reads.
    pnpm --filter @media/platform --config.inject-workspace-packages=true deploy --prod --offline "$lib/platform"
    rm -rf "$lib/platform/test"
    mkdir -p "$lib/platform/node_modules/@media"
    cp -r packages/config "$lib/platform/node_modules/@media/config"
    sh deploy/functions-hash.sh "$lib/platform" >"$lib/platform/.functions-hash"
    cp packages/platform/scripts/configure.mjs $lib/platform/scripts/
    rm $lib/platform/scripts/configure.ts
    install -D -m 644 deploy/image/rootfs/etc/caddy/Caddyfile $lib/Caddyfile

    cp -r apps/media/dist $lib/media/dist
    cp apps/media/scripts/configure-web.ts $lib/media/scripts/
    cp -r apps/web-movies/dist $lib/web
    cp -r apps/web-account/dist $lib/account

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-media \
      --add-flags "--enable-source-maps $lib/media/dist/main.js" \
      --set-default FFMPEG_PATH ${lib.getExe' ffmpeg-full "ffmpeg"} \
      --set-default FFPROBE_PATH ${lib.getExe' ffmpeg-full "ffprobe"} \
      --set-default CONVEX_BACKEND_DIR $lib/platform

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure-web \
      --add-flags "$lib/media/scripts/configure-web.ts --from $lib/web"

    makeWrapper ${lib.getExe nodejs} $out/bin/movies-configure-account \
      --add-flags "$lib/media/scripts/configure-web.ts --from $lib/account"

    # The Convex CLI reads the project's package.json, so both run from its folder.
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
