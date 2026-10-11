# Demo library

The demo and the screenshots use five Creative Commons releases from the Internet Archive:
28 tracks, two of them lossless FLAC EPs, about 520 MB.

```sh
scripts/download-demo-music.sh ~/music-demo
docker run -d -p 8080:8080 -v music-data:/data -v ~/music-demo:/music:ro ghcr.io/lmdevv/music:main
```

The script keeps the original file names, adds tags to the one release that ships without them,
links each release's artwork as `cover.jpg`, and writes the credits below to `CREDITS.md` next to
the music.

## Credits

- **raymundo mendoza — translations ep (2010)**. Music by raymundo mendoza. Released by unfoundsound. [Source](https://archive.org/details/unfound53). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Dadive — Frightening Freighters EP (2018)**. Music by Dadive. Released by monoKraK. [Source](https://archive.org/details/MonoKraK207Dadive_FrighteningFreightersEP). Licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. These FLAC files are Internet Archive lossless encodings of the original WAV recordings. The download script adds artist, album, title, and track tags, which the source files lack; the audio is unchanged.

- **Doc & Lena Selyanina — Cosmic Lullabies (2008)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt018). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made.

- **Doc & Lena Selyanina — Vienna Blue (2009)**. Music by Doc & Lena Selyanina. Released by Musictrade. [Source](https://archive.org/details/mt021). Licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Additional source credits: guitar on “Wanderer”: Mahmoud el Kipikapi; voices on “Doppelgänger”: KraftiM, Softspace, TheOmen; Sigmund Freud recording: Internet Archive; sound samples: Corsica_S, Ingsey101, Acclivity. [Original release notes](https://archive.org/download/mt021/mt021_release_info.txt).

- **Andy G. Cohen — Prisma (2021)**. Music by Andy G. Cohen. Released by Andy G. Cohen. [Source](https://archive.org/details/andy-g.-cohen-prisma). Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Audio and supplied cover reproduced as distributed by the source; no creative changes made. Track-specific credit: Music: “Hoist”, “Decapod”, “In Awareness”, “Gazing”, “Minty Soak”, “Our Young Guts”, “Epoxy Resin”, “Zwetschge”, “Crunch Me Beautiful”, “Upbridge”, “Roost”; by Andy G. Cohen; released under Creative Commons Attribution 4.0 International (CC BY 4.0).

The artists and labels do not endorse this demo. The music retains its individual Creative Commons licenses. Any adaptations of CC BY-SA material must retain the applicable ShareAlike license.
