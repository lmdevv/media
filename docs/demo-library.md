# Demo library

`ghcr.io/lmdevv/media-demo-library:v1` holds demo films, shows, and music as a data-only image,
so a server can show every feature without your own media and without a download script. It
holds about 7.5 GB: the full set of `scripts/demo-library.sh` (about 6.9 GB) and the five albums
that `[music]` used for its demo (about 520 MB).

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
| `Music/raymundo mendoza/translations ep`        | Five lossless FLAC tracks                                                                                                                    |
| `Music/Dadive/Frightening Freighters EP`        | Two lossless FLAC tracks that ship untagged; the download script tagged them                                                                 |
| `Music/Doc & Lena Selyanina/Cosmic Lullabies`   | Three long MP3 tracks, and one artist across two albums                                                                                      |
| `Music/Doc & Lena Selyanina/Vienna Blue`        | Seven MP3 tracks with per-track credits                                                                                                      |
| `Music/Andy G. Cohen/Prisma`                    | An eleven-track MP3 album                                                                                                                    |

Every title has a Kodi-style NFO, so it matches without a TMDB key, and local artwork. Every album
has its cover as `cover.jpg`. The image also holds `CREDITS.md` for the films and
`Music/CREDITS.md` for the music; the credits are below.

## Use it with Docker Compose

`deploy/compose/compose.demo.yaml` mounts the image read-only at `/media/library` in place of
`MEDIA_LIBRARY` (Docker 28 or later). Docker pulls it once per machine, and every container that
mounts it shares that copy. From `deploy/compose`:

```sh
docker compose -f compose.yaml -f compose.demo.yaml up -d
```

Open the web app, create the owner account, and add `/media/library/Movies` as a movies library
and `/media/library/Shows` as a shows library. With plain `docker run`, the same mount is
`--mount type=image,source=ghcr.io/lmdevv/media-demo-library:v1,target=/media/library`. To mount
only the music, add `image-subpath=Music` to that mount.

## Build it

`deploy/demo-library/Dockerfile` builds the image from two published images, each pinned by
digest. `ghcr.io/lmdevv/movies-demo-library:v1` is the base, so its film and show layers carry
over byte for byte, and a machine that already has it pulls only the music. The albums come from
`ghcr.io/lmdevv/music-demo-library:v1`, one layer each, under `Music`. The build downloads nothing
from the films' and albums' own sources.

`scripts/build-demo-library.sh` builds the image into the local Docker and checks that it holds
every folder above, with the Feature Test's four versions, every episode, and all 28 tracks. The
Demo library workflow runs it on pull requests, and publishes the version named in
`deploy/demo-library/image` for amd64 and arm64 when it changes on main. A published version never
changes: to change what goes in, bump the version there and in `deploy/compose/compose.demo.yaml`
(`scripts/check-deploy.sh` checks that they match).

## Credits

Every film and album here is free to share under the license listed. The NFO summaries are the
project's own words. The artists, studios, and labels do not endorse [media].

| Item                                          | Made by                                      | License      | Source                                                        |
| --------------------------------------------- | -------------------------------------------- | ------------ | ------------------------------------------------------------- |
| Big Buck Bunny (2008)                         | Blender Foundation, peach.blender.org        | CC BY 3.0    | archive.org/details/BigBuckBunny_124                          |
| Elephants Dream (2006)                        | Blender Foundation, orange.blender.org       | CC BY 2.5    | download.blender.org/ED                                       |
| Sintel (2010)                                 | Blender Foundation, durian.blender.org       | CC BY 3.0    | download.blender.org/durian                                   |
| Tears of Steel (2012)                         | Blender Foundation, mango.blender.org        | CC BY 3.0    | download.blender.org/demo/movies/ToS                          |
| Cosmos Laundromat: First Cycle (2015)         | Blender Institute, gooseberry.blender.org    | CC BY 4.0    | archive.org/details/CosmosLaundromatFirstCycle                |
| Caminandes (2013-2016)                        | Blender Institute, caminandes.com            | CC BY 3.0    | archive.org (caminandes-1/2/3)                                |
| Pioneer One (2010)                            | Josh Bernhard and Bracey Smith               | CC BY-SA 4.0 | archive.org (pioneer-one-ep.-1 … 6)                           |
| raymundo mendoza, translations ep (2010)      | raymundo mendoza, released by unfoundsound   | CC BY 3.0    | archive.org/details/unfound53                                 |
| Dadive, Frightening Freighters EP (2018)      | Dadive, released by monoKraK                 | CC BY-SA 3.0 | archive.org/details/MonoKraK207Dadive_FrighteningFreightersEP |
| Doc & Lena Selyanina, Cosmic Lullabies (2008) | Doc & Lena Selyanina, released by Musictrade | CC BY 3.0    | archive.org/details/mt018                                     |
| Doc & Lena Selyanina, Vienna Blue (2009)      | Doc & Lena Selyanina, released by Musictrade | CC BY 3.0    | archive.org/details/mt021                                     |
| Andy G. Cohen, Prisma (2021)                  | Andy G. Cohen                                | CC BY 4.0    | archive.org/details/andy-g.-cohen-prisma                      |

The "[movies] Feature Test" versions are cut and re-encoded from Sintel (CC BY 3.0, Blender
Foundation). Posters, backgrounds, and stills are frames taken from each film. The albums' audio
and supplied covers are reproduced as their sources distribute them. The Dadive FLAC files are the
Internet Archive's lossless encodings of the original WAV recordings, and the download script
added the artist, album, title, and track tags they lack; the audio is unchanged. Vienna Blue also
credits Mahmoud el Kipikapi (guitar on "Wanderer"), KraftiM, Softspace, and TheOmen (voices on
"Doppelgänger"), the Internet Archive (the Sigmund Freud recording), and Corsica_S, Ingsey101, and
Acclivity (sound samples), per its
[release notes](https://archive.org/download/mt021/mt021_release_info.txt). Adaptations of the
CC BY-SA material must keep its license.
