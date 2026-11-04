# The demo library: the full set of scripts/demo-library.sh (six films, the four-version
# "[movies] Feature Test", Caminandes, and Pioneer One, about 6.5 GB) and its CREDITS.md, in a
# data-only image. It holds no OS and runs nothing. Mount it read-only where the media service
# reads libraries (Docker 28 or later), then add /media/library/Movies and /media/library/Shows:
#
#   docker run ... --mount type=image,source=ghcr.io/lmdevv/movies-demo-library:v1,target=/media/library ...
#
# docs/demo-library.md has the compose form. scripts/build-demo-library.sh builds it, and the Demo
# library workflow publishes it.
#
# One layer per title, and one per Pioneer One episode, so a pull downloads in parallel and resumes
# per title, and no layer comes near the registry's size limit. "?" stands for the brackets of
# "[movies]", which COPY would read as a pattern.
FROM scratch
LABEL org.opencontainers.image.title="[movies] demo library" \
  org.opencontainers.image.description="Creative Commons films and shows for [movies] demos and tests" \
  org.opencontainers.image.source="https://github.com/lmdevv/media" \
  org.opencontainers.image.licenses="CC-BY-2.5 AND CC-BY-3.0 AND CC-BY-4.0 AND CC-BY-SA-4.0"
COPY CREDITS.md /
COPY ["Movies/Big Buck Bunny (2008)", "/Movies/Big Buck Bunny (2008)/"]
COPY ["Movies/Elephants Dream (2006)", "/Movies/Elephants Dream (2006)/"]
COPY ["Movies/Sintel (2010)", "/Movies/Sintel (2010)/"]
COPY ["Movies/Tears of Steel (2012)", "/Movies/Tears of Steel (2012)/"]
COPY ["Movies/Cosmos Laundromat - First Cycle (2015)", "/Movies/Cosmos Laundromat - First Cycle (2015)/"]
COPY ["Movies/?movies? Feature Test (2010)", "/Movies/[movies] Feature Test (2010)/"]
COPY ["Shows/Caminandes (2013)", "/Shows/Caminandes (2013)/"]
COPY ["Shows/Pioneer One (2010)/tvshow.nfo", "Shows/Pioneer One (2010)/poster.jpg", "Shows/Pioneer One (2010)/fanart.jpg", "/Shows/Pioneer One (2010)/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E01 - *", "/Shows/Pioneer One (2010)/Season 01/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E02 - *", "/Shows/Pioneer One (2010)/Season 01/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E03 - *", "/Shows/Pioneer One (2010)/Season 01/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E04 - *", "/Shows/Pioneer One (2010)/Season 01/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E05 - *", "/Shows/Pioneer One (2010)/Season 01/"]
COPY ["Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E06 - *", "/Shows/Pioneer One (2010)/Season 01/"]
