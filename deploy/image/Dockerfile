# syntax=docker/dockerfile:1.7
# [media] all-in-one image: Caddy on one port in front of the core's Convex backend, old movies'
# Convex backend, and the media service, under s6 (docs/decisions/0015 and 0025). It serves the
# account client at /, the movies client at /movies, and holds the `media` CLI and ffmpeg with
# Intel Quick Sync. Build from the repo root:
#   docker build -f deploy/image/Dockerfile -t media .

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
# `generate_key` derives the admin key from the backend's instance secret and must match its version.
ARG CONVEX_IMAGE=ghcr.io/convex/convex-backend:5c7cb5bc7db457290f1769f95f1d1340912f7fd7@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
# caddy:2.11
ARG CADDY_IMAGE=caddy:2.11@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772

FROM ${CONVEX_IMAGE} AS convex

FROM ${CADDY_IMAGE} AS caddy

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS argv-secret
ARG TARGETARCH
COPY deploy/image/argv-secret.c /src/
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) triple=x86_64-linux-gnu; cross=gcc-x86-64-linux-gnu ;; \
      arm64) triple=aarch64-linux-gnu; cross=gcc-aarch64-linux-gnu ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    if [ "$(dpkg --print-architecture)" = "${TARGETARCH:-amd64}" ]; then \
      packages="gcc libc6-dev"; cc=gcc; \
    else \
      packages="$cross libc6-dev-${TARGETARCH}-cross"; cc="$triple-gcc"; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*; \
    "$cc" -shared -fPIC -O2 -Wall -Wextra -Werror -o /argv-secret.so /src/argv-secret.c

# JavaScript builds are architecture-independent, so build on the native platform and install the
# native optional binaries (esbuild, which `convex deploy` runs at startup) for both target CPUs.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --os=linux --cpu=x64 --cpu=arm64 --libc=glibc
# Both web clients are built once with a placeholder Convex URL that init replaces at startup.
RUN VITE_CONVEX_URL=__MEDIA_CONVEX_URL__ pnpm --config.verify-deps-before-run=false --filter web build --base=/movies/ \
 && VITE_PLATFORM_URL=__MEDIA_CONVEX_URL__ pnpm --config.verify-deps-before-run=false --filter @media/web-account build \
 && pnpm --config.verify-deps-before-run=false --filter @media/server build \
 && pnpm --config.verify-deps-before-run=false --filter @lmdevv/movies build
# Each Convex project's tsconfig extends the shared config, which `convex deploy` reads. The
# core's configure script imports TypeScript from a workspace package, which Node does not strip
# inside node_modules, so it ships bundled.
RUN for project in backend platform; do \
      pnpm --filter "@media/$project" deploy --prod --legacy "/out/$project" \
      && rm -rf "/out/$project/test" \
      && mkdir -p "/out/$project/node_modules/@media" \
      && cp -r packages/config "/out/$project/node_modules/@media/config" \
      && sh deploy/functions-hash.sh "/out/$project" >"/out/$project/.functions-hash"; \
    done \
 && pnpm --config.verify-deps-before-run=false --filter @media/server exec esbuild ../../packages/platform/scripts/configure.ts \
      --bundle --platform=node --format=esm --target=node24 --log-level=warning \
      --outfile=/out/platform/scripts/configure.mjs \
 && rm /out/platform/scripts/configure.ts \
 && mkdir -p /out/media/scripts \
 && cp -r apps/media/dist /out/media/dist \
 && cp apps/media/scripts/configure-web.ts /out/media/scripts/ \
 && cp -r apps/web/dist /out/web \
 && cp -r apps/web-account/dist /out/account \
 && install -D -m 644 apps/cli/dist/media.js /out/cli/media.mjs \
 && install -m 644 apps/cli/dist/THIRD_PARTY_LICENSES.md /out/cli/

FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.1.0
# SHA-256 of the s6-overlay release tarballs, from the release's .sha256 files.
ARG S6_OVERLAY_NOARCH_SHA256=42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5
ARG S6_OVERLAY_X86_64_SHA256=8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435
ARG S6_OVERLAY_AARCH64_SHA256=c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc
# Debian's ffmpeg 7.1 is built with libvpl (oneVPL). On amd64 add Intel's iHD VA-API driver and the
# oneVPL GPU runtime, which give Quick Sync on Gen12+ (Tiger Lake and newer) iGPUs, and Mesa's
# VA-API drivers for AMD GPUs. xz-utils unpacks s6-overlay; curl is the health check.
RUN set -eux; \
    sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    packages="ffmpeg ca-certificates curl xz-utils"; \
    if [ "${TARGETARCH:-amd64}" = amd64 ]; then \
      packages="$packages intel-media-va-driver-non-free libmfx-gen1.2 libvpl2 mesa-va-drivers vainfo"; \
    fi; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) s6arch=x86_64; s6sum="$S6_OVERLAY_X86_64_SHA256" ;; \
      arm64) s6arch=aarch64; s6sum="$S6_OVERLAY_AARCH64_SHA256" ;; \
      *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/s6-overlay-noarch.tar.xz"; \
    curl -fsSLO "$base/s6-overlay-${s6arch}.tar.xz"; \
    printf '%s  %s\n' "$S6_OVERLAY_NOARCH_SHA256" s6-overlay-noarch.tar.xz \
      "$s6sum" "s6-overlay-${s6arch}.tar.xz" | sha256sum -c -; \
    tar -C / -Jxpf s6-overlay-noarch.tar.xz; \
    tar -C / -Jxpf "s6-overlay-${s6arch}.tar.xz"; \
    rm s6-overlay-*.tar.xz
# Every service runs as its own unprivileged user. The media service runs as `movies`, which init
# moves to PUID/PGID at boot; the base image's `node` user held uid 1000. Both Convex backends and
# Caddy get fixed system ids that PUID/PGID may not take.
RUN userdel --remove node \
 && groupadd --gid 1000 movies \
 && useradd --uid 1000 --gid movies --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin movies \
 && groupadd --system --gid 901 convex \
 && useradd --system --uid 901 --gid convex --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin convex \
 && groupadd --system --gid 902 caddy \
 && useradd --system --uid 902 --gid caddy --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin caddy

# The Convex image ships its binaries executable by root only; the backends run as `convex`.
COPY --from=convex --chmod=755 /convex/convex-local-backend /convex/generate_key /app/convex/
COPY --from=argv-secret --chmod=755 /argv-secret.so /app/convex/argv-secret.so
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
ARG CONVEX_IMAGE
RUN printf '%s\n' "$CONVEX_IMAGE" >/app/convex/image
COPY --from=build /out/backend /app/backend
COPY --from=build /out/platform /app/platform
COPY --from=build /out/media /app/media
COPY --from=build /out/web /app/web
COPY --from=build /out/account /app/account
COPY --from=build /out/cli /app/cli
COPY deploy/image/media-cli.sh /usr/local/bin/media
COPY deploy/image/rootfs/ /

ENV NODE_ENV=production \
    MEDIA_BASE_URL=http://localhost:8080 \
    PUID=1000 \
    PGID=1000 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_VERBOSITY=1 \
    S6_SERVICES_GRACETIME=24000 \
    S6_KILL_GRACETIME=3000
# On a stop, s6 stops the media service first, which ends open responses 3 s in and then closes
# its streams, then both Convex backends (with SIGINT, which shuts their databases down cleanly)
# and Caddy. It waits up to 24 seconds for them and 3 more before it kills what is left, so give
# the container a 30-second stop timeout (`--stop-timeout 30`, or Compose's stop_grace_period).

VOLUME ["/data", "/transcode"]
EXPOSE 8080
# Healthy while Caddy, the media service with its Convex backend, and the core's Convex answer. The
# media service starts only after init, which backs up before an upgrade and deploys both
# projects, so the start period is long; it ends at the first passing check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --start-interval=2s \
  CMD curl -fsS http://127.0.0.1:8080/api/health | grep -q '"backend":"connected"' \
   && curl -fsS -o /dev/null http://127.0.0.1:8080/convex/version
ENTRYPOINT ["/init"]
