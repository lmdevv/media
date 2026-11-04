# Demo library

`ghcr.io/lmdevv/movies-demo-library:v1` is the full set of `scripts/demo-library.sh` as a
data-only image, so a server can show every feature without your own films and without a
download script. It holds about 7 GB, in one layer per title (and per Pioneer One episode):

| Folder                                          | What it exercises                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Movies/Big Buck Bunny (2008)`                  | Direct play (H.264 and AAC in MP4)                                                                                                           |
| `Movies/Elephants Dream (2006)`                 | A QuickTime `.mov`                                                                                                                           |
| `Movies/Sintel (2010)`                          | MKV with AC3 5.1 and ten embedded subtitles, played as HLS with the audio transcoded                                                         |
| `Movies/Tears of Steel (2012)`                  | Sidecar subtitles in 20 languages                                                                                                            |
| `Movies/Cosmos Laundromat - First Cycle (2015)` | A sort title and sidecar subtitles                                                                                                           |
| `Movies/[movies] Feature Test (2010)`           | Four versions of one title: direct play with chapters, HDR10 HEVC, multiple audio tracks with text and image subtitles, interlaced SD MPEG-2 |
| `Shows/Caminandes (2013)`                       | Three episodes of VP8 and Vorbis in Ogg, always transcoded                                                                                   |
| `Shows/Pioneer One (2010)`                      | A six-episode season, for Continue Watching and the next episode                                                                             |

Every title has a Kodi-style NFO, so it matches without a TMDB key, and local artwork. The image
also holds `CREDITS.md`; the credits are below.

## Use it with Docker Compose

`deploy/compose/compose.demo.yaml` mounts the image read-only at `/media/library` in place of
`MEDIA_LIBRARY` (Docker 28 or later). Docker pulls it once per machine, and every container that
mounts it shares that copy. From `deploy/compose`:

```sh
docker compose -f compose.yaml -f compose.demo.yaml up -d
```

Open the web app, create the owner account, and add `/media/library/Movies` as a movies library
and `/media/library/Shows` as a shows library. With plain `docker run`, the same mount is
`--mount type=image,source=ghcr.io/lmdevv/movies-demo-library:v1,target=/media/library`.

## Build it

`scripts/build-demo-library.sh` downloads the full set into a temporary folder and builds the
image, or builds from a finished download with `--from ~/movies-demo` (run
`scripts/demo-library.sh --set full --dir ~/movies-demo` first). It checks that the folder holds
every title, complete with the Feature Test's image subtitle, since the Dockerfile copies titles by
name. The Demo library workflow publishes the version named in `deploy/demo-library/image` for
amd64 and arm64 when it changes on main. A published version never changes: to change what goes
in, bump the version there and in `deploy/compose/compose.demo.yaml` (`scripts/check-deploy.sh`
checks that they match).

## Credits

Every film here is free to share under the license listed. The NFO summaries are the project's
own words. The artists and studios do not endorse [movies].

| Title                                 | Made by                                   | License      | Source                                         |
| ------------------------------------- | ----------------------------------------- | ------------ | ---------------------------------------------- |
| Big Buck Bunny (2008)                 | Blender Foundation, peach.blender.org     | CC BY 3.0    | archive.org/details/BigBuckBunny_124           |
| Elephants Dream (2006)                | Blender Foundation, orange.blender.org    | CC BY 2.5    | download.blender.org/ED                        |
| Sintel (2010)                         | Blender Foundation, durian.blender.org    | CC BY 3.0    | download.blender.org/durian                    |
| Tears of Steel (2012)                 | Blender Foundation, mango.blender.org     | CC BY 3.0    | download.blender.org/demo/movies/ToS           |
| Cosmos Laundromat: First Cycle (2015) | Blender Institute, gooseberry.blender.org | CC BY 4.0    | archive.org/details/CosmosLaundromatFirstCycle |
| Caminandes (2013-2016)                | Blender Institute, caminandes.com         | CC BY        | archive.org (caminandes-1/2/3)                 |
| Pioneer One (2010)                    | Josh Bernhard and Bracey Smith            | CC BY-SA 4.0 | archive.org (pioneer-one-ep.-1 … 6)            |

The "[movies] Feature Test" versions are cut and re-encoded from Sintel (CC BY 3.0, Blender
Foundation). Posters, backgrounds, and stills are frames taken from each film. Adaptations of the
CC BY-SA material must keep its license.
