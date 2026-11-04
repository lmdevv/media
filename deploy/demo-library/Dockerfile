# The demo library: the movies demo library (six films, the four-version "[movies] Feature Test",
# Caminandes, and Pioneer One, about 6.9 GB) and the music demo library (five albums, about 520 MB)
# in one data-only image. It holds no OS and runs nothing. Mount it read-only where the server reads
# libraries (Docker 28 or later), then add /media/library/Movies, /media/library/Shows, and
# /media/library/Music:
#
#   docker run ... --mount type=image,source=ghcr.io/lmdevv/media-demo-library:v1,target=/media/library ...
#
# docs/demo-library.md has the compose form and the credits. scripts/build-demo-library.sh builds
# it, and the Demo library workflow publishes it.
#
# Both parts come from published images pinned by digest, so the build downloads nothing from the
# films' and albums' sources. The movies image is the base: its layers, one per title and one per
# Pioneer One episode, carry over unchanged, so a machine that already has it pulls only the music.
# Each album gets its own layer on top, under /Music.
FROM ghcr.io/lmdevv/music-demo-library:v1@sha256:f62a095b34212379307a6c298588cec3461498b083d805c2922ec1b20480eddb AS music
FROM ghcr.io/lmdevv/movies-demo-library:v1@sha256:27fe29bb32af3f06e57de70c3453ac36f347ff171c143681a23bf954f353a43b
LABEL org.opencontainers.image.title="[media] demo library" \
  org.opencontainers.image.description="Creative Commons films, shows, and music for [media] demos and tests" \
  org.opencontainers.image.source="https://github.com/lmdevv/media" \
  org.opencontainers.image.licenses="CC-BY-2.5 AND CC-BY-3.0 AND CC-BY-4.0 AND CC-BY-SA-3.0 AND CC-BY-SA-4.0"
COPY --from=music /CREDITS.md /Music/
COPY --from=music ["/raymundo mendoza/translations ep", "/Music/raymundo mendoza/translations ep/"]
COPY --from=music ["/Dadive/Frightening Freighters EP", "/Music/Dadive/Frightening Freighters EP/"]
COPY --from=music ["/Doc & Lena Selyanina/Cosmic Lullabies", "/Music/Doc & Lena Selyanina/Cosmic Lullabies/"]
COPY --from=music ["/Doc & Lena Selyanina/Vienna Blue", "/Music/Doc & Lena Selyanina/Vienna Blue/"]
COPY --from=music ["/Andy G. Cohen/Prisma", "/Music/Andy G. Cohen/Prisma/"]
