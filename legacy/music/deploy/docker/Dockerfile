# syntax=docker/dockerfile:1.7
# [music] all-in-one image: self-hosted Convex, the media service, the web app, and Caddy,
# supervised by s6-overlay. Build from the repo root:
#   docker build -f deploy/docker/Dockerfile -t music .

# Base images are pinned by the digest of their multi-arch index; the tag each digest was taken
# from is in the comment above it. Update both together.
# node:24-trixie-slim
ARG NODE_IMAGE=node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
# ghcr.io/get-convex/convex-backend (scripts/dev-backend.sh reads this line to run the same one)
ARG CONVEX_IMAGE=ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
# caddy:2.11
ARG CADDY_IMAGE=caddy:2.11@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772

FROM ${CONVEX_IMAGE} AS convex

FROM ${CADDY_IMAGE} AS caddy

# The LD_PRELOAD shim that keeps the Convex instance secret off command lines (see its source).
# Compiled on the build machine, with a cross compiler when the target CPU differs, so no part of
# it runs under emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS argv-secret
ARG TARGETARCH
COPY deploy/docker/argv-secret.c /src/
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

# JavaScript builds are architecture-independent, so build on the native platform and install
# native optional binaries (esbuild, used by `convex deploy` at runtime) for both target CPUs.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG CONVEX_IMAGE
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --os=linux --cpu=x64 --cpu=arm64 --libc=glibc
# The install adds binaries for both target CPUs, so skip pnpm's re-install check before runs.
RUN pnpm --config.verify-deps-before-run=false --filter web build \
 && pnpm --config.verify-deps-before-run=false --filter @music/media build
# Standalone package directories with production node_modules.
RUN pnpm --filter @music/backend deploy --prod --legacy /out/backend \
 && pnpm --filter @music/media deploy --prod --legacy /out/media \
 && cp -r apps/web/dist /out/web
# The build identity: a hash of everything that decides what init deploys to Convex, and of the
# Convex backend itself. Init exports a backup before deploying whenever it differs from the one
# recorded in /data, so a change to functions, schema, or migrations is backed up first, on :main
# as much as on a release. It errs towards backing up: any lockfile change also changes it. A
# failure anywhere in the pipeline fails the build rather than hashing a partial list.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN files="$(find packages/backend/convex packages/backend/package.json packages/commands \
      pnpm-lock.yaml -type f -not -path '*/node_modules/*' | LC_ALL=C sort)"; \
    [ "$(grep -c '^packages/backend/convex/schema.ts$' <<<"$files")" = 1 ]; \
    { printf '%s\n' "$CONVEX_IMAGE"; xargs -d '\n' sha256sum <<<"$files"; } \
      | sha256sum | cut -c1-16 > /out/build-id; \
    grep -Eq '^[0-9a-f]{16}$' /out/build-id

FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.1.0
# SHA-256 of the s6-overlay release tarballs, from the release's .sha256 files.
ARG S6_OVERLAY_NOARCH_SHA256=42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5
ARG S6_OVERLAY_X86_64_SHA256=8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435
ARG S6_OVERLAY_AARCH64_SHA256=c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc
# tzdata so that TZ sets the local time in logs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates xz-utils curl tzdata \
 && rm -rf /var/lib/apt/lists/*
# Every service runs as its own unprivileged user. The media service, which parses every file in
# the library with ffmpeg, runs as `music`; init moves it to PUID/PGID at boot. The base image's
# `node` user held uid 1000. Convex and Caddy get fixed system ids that PUID/PGID may not take.
RUN userdel --remove node \
 && groupadd --gid 1000 music \
 && useradd --uid 1000 --gid music --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin music \
 && groupadd --system --gid 901 convex \
 && useradd --system --uid 901 --gid convex --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin convex \
 && groupadd --system --gid 902 caddy \
 && useradd --system --uid 902 --gid caddy --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin caddy
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

# The Convex image ships its binaries executable by root only; the backend runs as `convex`.
COPY --from=convex --chmod=755 /convex/convex-local-backend /convex/generate_key /app/convex/
COPY --from=argv-secret --chmod=755 /argv-secret.so /app/convex/argv-secret.so
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /out/backend /app/backend
COPY --from=build /out/media /app/media
COPY --from=build /out/web /app/web
COPY --from=build /out/build-id /app/build-id
COPY deploy/docker/rootfs/ /

ENV PUBLIC_URL=http://localhost:8080 \
    MUSIC_DATA=/data \
    MUSIC_ROOTS=/music \
    PUID=1000 \
    PGID=1000 \
    BACKUP_KEEP=5 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_VERBOSITY=1 \
    S6_SERVICES_GRACETIME=6000 \
    S6_KILL_GRACETIME=2000
# On `docker stop`, s6 stops the media service, then Convex (with SIGINT, which shuts its
# database down cleanly) and Caddy, waiting up to 6 seconds for them, then 2 more before killing
# what is left: 8 seconds in all, inside Docker's default 10-second stop timeout.

VOLUME ["/data"]
EXPOSE 8080
# /healthz is the media service's health check through Caddy, and that check queries Convex, so
# the container is healthy only while Caddy, the media service, and Convex all answer. The media
# service starts only after init, which exports a backup and deploys on an upgrade; with a large
# database that takes minutes, so the start period is long enough not to call an upgrade
# unhealthy (it ends at the first passing check, made every 5 seconds until then).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --start-interval=5s \
  CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/init"]
