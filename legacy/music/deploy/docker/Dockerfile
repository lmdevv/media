# syntax=docker/dockerfile:1.7
# [music] all-in-one image: self-hosted Convex, the media service, the web app, and Caddy,
# supervised by s6-overlay. Build from the repo root:
#   docker build -f deploy/docker/Dockerfile -t music .

ARG NODE_IMAGE=node:24-trixie-slim
ARG CONVEX_IMAGE=ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
ARG CADDY_IMAGE=caddy:2.11

FROM ${CONVEX_IMAGE} AS convex

FROM ${CADDY_IMAGE} AS caddy

# JavaScript builds are architecture-independent, so build on the native platform and install
# native optional binaries (esbuild, used by `convex deploy` at runtime) for both target CPUs.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
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

FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.1.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates xz-utils curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) s6arch=x86_64 ;; arm64) s6arch=aarch64 ;; *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; esac; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    curl -fsSL "$base/s6-overlay-noarch.tar.xz" | tar -C / -Jxp; \
    curl -fsSL "$base/s6-overlay-${s6arch}.tar.xz" | tar -C / -Jxp

COPY --from=convex /convex/convex-local-backend /convex/generate_key /app/convex/
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /out/backend /app/backend
COPY --from=build /out/media /app/media
COPY --from=build /out/web /app/web
COPY deploy/docker/rootfs/ /

ENV PUBLIC_URL=http://localhost:8080 \
    MUSIC_DATA=/data \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_VERBOSITY=1

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/init"]
