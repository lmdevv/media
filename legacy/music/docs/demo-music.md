# Demo library

The demo and the screenshots use five Creative Commons releases from the Internet Archive:
28 tracks, two of them lossless FLAC EPs, about 520 MB.

They ship as a data-only image pinned by version and digest in `deploy/demo-library/image`.
A server mounts the image read-only (Docker 28 or later). Docker pulls it once per machine,
and every container shares it:

```sh
demo_image="$(cat deploy/demo-library/image)"
docker run -d -p 8080:8080 -v music-data:/data \
  --mount "type=image,source=$demo_image,target=/music" \
  ghcr.io/lmdevv/music:main
```

The Demo library workflow runs `scripts/check-demo-library.sh` on pull requests and pushes to
validate the pinned GHCR image, all 28 audio streams, five covers, and credits. Routine checks and
verification runs consume this image. Ordinary demo, CI, and verification runs never contact the
Internet Archive. If a pull fails, check Docker and access to GHCR, then retry.

## Publish a new version

Rebuilding is a maintainer operation. Run the **Publish demo library** workflow manually with a
new, unused version such as `v2`. It runs `scripts/build-demo-library.sh --version v2 --push`;
published versions cannot be overwritten. For a local build, omit `--push`. The version is
required and independent of the consumer pin.

The builder uses `scripts/download-demo-music.sh <dir>` to fetch the releases from the Internet
Archive. It keeps the original file names, adds tags to the one release that ships without them,
links each release's artwork as `cover.jpg`, and writes the credits below to `CREDITS.md` next to
the music. Pass `--from DIR` to reuse an existing download.

After publishing, inspect the actual registry index with
`docker buildx imagetools inspect ghcr.io/lmdevv/music-demo-library:v2`. Copy its `Digest` into
`deploy/demo-library/image` with the version, in the form
`ghcr.io/lmdevv/music-demo-library:v2@sha256:<index-digest>`. Submit that pin change in a reviewed
PR and run `scripts/check-demo-library.sh` against it. Publishing alone does not update consumers.

## Credits

- **raymundo mendoza — translations ep (2010)**. Music by raymundo mendoza. Released by unfoundsound. [Source](https://archive.org/details/unfound53). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Dadive — Frightening Freighters EP (2018)**. Music by Dadive. Released by monoKraK. [Source](https://archive.org/details/MonoKraK207Dadive_FrighteningFreightersEP). Licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. These FLAC files are Internet Archive lossless encodings of the original WAV recordings. The download script adds artist, album, title, and track tags, which the source files lack; the audio is unchanged.

- **Doc & Lena Selyanina — Cosmic Lullabies (2008)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt018). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Doc & Lena Selyanina — Vienna Blue (2009)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt021). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Additional source credits: guitar on “Wanderer”: Mahmoud el Kipikapi; voices on “Doppelgänger”: KraftiM, Softspace, TheOmen; Sigmund Freud recording: Internet Archive; sound samples: Corsica_S, Ingsey101, Acclivity. [Original release notes](https://archive.org/download/mt021/mt021_release_info.txt).

- **Andy G. Cohen — Prisma (2021)**. Music by Andy G. Cohen. Released by Andy G. Cohen. [Source](https://archive.org/details/andy-g.-cohen-prisma). Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Track-specific credit: Music: “Hoist”, “Decapod”, “In Awareness”, “Gazing”, “Minty Soak”, “Our Young Guts”, “Epoxy Resin”, “Zwetschge”, “Crunch Me Beautiful”, “Upbridge”, “Roost”; by Andy G. Cohen; released under Creative Commons Attribution 4.0 International (CC BY 4.0).

The artists and labels do not endorse this demo. The music retains its individual Creative Commons licenses. Any adaptations of CC BY-SA material must retain the applicable ShareAlike license.
