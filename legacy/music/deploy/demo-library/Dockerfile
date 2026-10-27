# The demo library: the five Creative Commons releases of scripts/download-demo-music.sh and their
# CREDITS.md, in a data-only image. It holds no OS and runs nothing. Mount it read-only where the
# server reads music (Docker 28 or later):
#
#   docker run -d -p 8080:8080 -v music-data:/data \
#     --mount type=image,source=ghcr.io/lmdevv/music-demo-library:v1,target=/music \
#     ghcr.io/lmdevv/music:main
#
# scripts/build-demo-library.sh builds it, and the Demo library workflow publishes it.
FROM scratch
LABEL org.opencontainers.image.title="[music] demo library" \
  org.opencontainers.image.description="Five Creative Commons releases for [music] demos and tests" \
  org.opencontainers.image.source="https://github.com/lmdevv/music" \
  org.opencontainers.image.licenses="CC-BY-3.0 AND CC-BY-SA-3.0 AND CC-BY-4.0"
COPY . /
