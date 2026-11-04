# syntax=docker/dockerfile:1.7
# [movies] media service image: the Effect media service, the built web app it serves, the
# deployed Convex functions with the pinned Convex CLI (deploy, configure, backups), the `media`
# CLI, and ffmpeg with Intel Quick Sync. The Convex backend runs as its own service (compose.yaml).
# Build from the repo root:
#   docker build -f deploy/compose/Dockerfile -t movies .

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
# `generate_key` derives the admin key from the backend's instance secret and must match its version.
ARG CONVEX_IMAGE=ghcr.io/convex/convex-backend:5c7cb5bc7db457290f1769f95f1d1340912f7fd7@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4

FROM ${CONVEX_IMAGE} AS convex

# JavaScript builds are architecture-independent, so build on the native platform and install the
# native optional binaries (esbuild, which `convex deploy` runs at startup) for both target CPUs.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --os=linux --cpu=x64 --cpu=arm64 --libc=glibc
RUN VITE_CONVEX_URL=__MEDIA_CONVEX_URL__ pnpm --config.verify-deps-before-run=false --filter web build \
 && pnpm --config.verify-deps-before-run=false --filter @media/server build \
 && pnpm --config.verify-deps-before-run=false --filter @lmdevv/movies build
# The backend's tsconfig extends the shared config, which `convex deploy` reads.
RUN pnpm --filter @media/backend deploy --prod --legacy /out/backend \
 && rm -rf /out/backend/test \
 && mkdir -p /out/backend/node_modules/@media \
 && cp -r packages/config /out/backend/node_modules/@media/config \
 && sh deploy/functions-hash.sh /out/backend >/out/backend/.functions-hash \
 && mkdir -p /out/media/scripts \
 && cp -r apps/media/dist /out/media/dist \
 && cp apps/media/scripts/configure-web.ts /out/media/scripts/ \
 && cp -r apps/web/dist /out/web \
 && install -D -m 644 apps/cli/dist/media.js /out/cli/media.mjs \
 && install -m 644 apps/cli/dist/THIRD_PARTY_LICENSES.md /out/cli/

FROM ${NODE_IMAGE}
ARG TARGETARCH
# Debian's ffmpeg 7.1 is built with libvpl (oneVPL). On amd64 add Intel's iHD VA-API driver and the
# oneVPL GPU runtime, which give Quick Sync on Gen12+ (Tiger Lake and newer) iGPUs, and Mesa's
# VA-API drivers for AMD GPUs.
RUN set -eux; \
    sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    packages="ffmpeg ca-certificates"; \
    if [ "${TARGETARCH:-amd64}" = amd64 ]; then \
      packages="$packages intel-media-va-driver-non-free libmfx-gen1.2 libvpl2 mesa-va-drivers vainfo"; \
    fi; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*
# The base image's `node` user held uid 1000.
RUN userdel --remove node \
 && groupadd --gid 1000 movies \
 && useradd --uid 1000 --gid movies --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin movies

COPY --from=convex /convex/generate_key /app/convex/generate_key
ARG CONVEX_IMAGE
RUN printf '%s\n' "$CONVEX_IMAGE" >/app/convex/image
COPY --from=build /out/backend /app/backend
COPY --from=build /out/media /app/media
COPY --from=build /out/web /app/web
COPY --from=build /out/cli /app/cli
COPY deploy/compose/movies.sh /usr/local/bin/media
COPY deploy/compose/entrypoint.sh /app/bin/entrypoint

ENV NODE_ENV=production \
    MEDIA_BASE_URL=http://localhost:8080 \
    CONVEX_PUBLIC_URL=http://localhost:3210 \
    CONVEX_URL=http://convex:3210 \
    PUID=1000 \
    PGID=1000

VOLUME ["/data", "/transcode"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/app/bin/entrypoint"]
