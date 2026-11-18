# Downloads

A person keeps a movie, an episode, an album, a playlist, or a song on their phone or tablet and
plays it with the server out of reach. A download belongs to the person on that device, counts
toward the device's limit, and is removed from the app or by removing them all. Web has no
downloads; the CLI keeps the same list for a device it registers as.

## Sub-features

- `download-add` downloads a title from its actions sheet in the movies iOS app.
- `download-list` shows the Downloads tab: what is kept, its state, and its size.
- `download-offline` plays a download with the server out of reach.
- `download-settings` shows the video quality, the storage used, and `Remove All Downloads`.
- `download-remove` removes one download, after asking.
- `download-cli` registers a CLI as a device, then keeps, lists, fetches, and removes an item.
- `download-cap` limits how many bytes a device may keep.
- `download-music` downloads an album in the music iOS app, plays it with the server out of
  reach, reports that play once the server is back, and removes every download at once.

## How to get to it (user POV)

- Movies iOS app: the `Downloads` tab (`/downloads`); a title's `More`, then `Download`
  (`/title/<id>/actions`); a download's page (`/download/<fileId>`); `Download Settings`
  (`/download-settings`).
- Music iOS app: an album's or playlist's `Download` button in its top bar; Settings, `Downloads`
  (`/settings/downloads`).
- Terminal: `media auth registry enroll <name>`, then `media auth downloads
  add|list|usage|fetch|remove`; for admins `media admin downloads set-cap`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, the side holds the demo library and the seed, and `$S ios up` printed
  `ready` with the movies app signed in as Lucía.
- Big Buck Bunny's title id, from `$S cli -- movies titles search --query "Big Buck Bunny"`, and
  its file id, the first `id` under `files` in `$S cli -- movies titles get --title-id <id>`.

- **Empty.** `$S ios open /downloads`: the heading `Downloads`, then `Nothing downloaded yet.` and
  the button `Browse Library`.
- **Download.** `$S ios open /title/<id>/actions` shows a sheet headed `Big Buck Bunny` with the
  button `Download`; `$S ios tap --label Download`. On the Downloads tab the row reads
  `Big Buck Bunny, Downloading · <n>%`, then `Big Buck Bunny, Ready to Play`, under `1 Item, 62
  MB`, with the buttons `Play Big Buck Bunny` and `More for Big Buck Bunny`.
- **Offline.** `$S ios offline on` cuts the app off from its server and leaves the app running;
  `$S ios doctor` then says so. `$S ios open /downloads` still lists the download, and
  `$S ios tap --label "Play Big Buck Bunny"` plays it: with the controls up (`$S ios tap -x 400 -y
  200`), `$S ios describe | grep 'Playback position'` reads a later time on a second look.
  `$S ios tap --label Close`, then `$S ios offline off` brings the server back.
- **Its page.** `$S ios open /download/<fileId>`: the heading `Big Buck Bunny`, `Play Download`,
  `Downloaded · 360p · 62 MB`, and `Remove Download`.
- **Settings.** `$S ios open /download-settings`: `Wi-Fi Only`, `Video Quality, Standard`,
  `Storage Used, 62 MB`, and `Remove All Downloads`. `$S ios open /download-settings/quality`
  offers `Standard, Selected` and `High, Larger Files`.
- **Remove.** On the download's page, `$S ios tap --label "Remove Download"` opens a sheet headed
  `Remove this download?` with a second `Remove Download` and `Cancel`; `$S ios find "Remove
  Download"` and `$S ios describe` give the sheet's button's point, for `$S ios tap -x X -y Y`.
  The Downloads tab then reads `Nothing downloaded yet.`
- **CLI.** Sign a config of its own in, `printf %s password123 | $S cli --as dlprobe -- auth login
  --server http://localhost:<port>/convex --username lucia`. `$S cli --as dlprobe -- auth downloads
  usage` exits 6 with `This session is on no device`, as it does for every seeded person's CLI.
  `$S cli --as dlprobe -- auth registry enroll "CLI probe" > <state>/dlprobe.json` registers it and
  prints its `deviceId` beside a device code to keep out of sight. Then, with
  `I='{"kind":"file","id":"<fileId>"}'`: `auth downloads add --item "$I"` prints `null`;
  `auth downloads list --limit 100` shows it `"state": "available"` with its `quality`, `bytes`,
  and `label`; `auth downloads usage` prints `bytes`, `"items": 1`, `capBytes`, and `capItems`;
  `auth downloads fetch --item "$I"` prints the `resource` to fetch; and `auth downloads remove
  --item "$I"` prints `null`, after which `usage` is back at `"items": 0`.
- **Cap.** `$S cli -- admin downloads set-cap --device-id <deviceId> --bytes 1000`, then the same
  `add`: exit 6 with `Downloads on this device take 0 bytes of its 1.0 KB limit, and this one
  needs …; remove some first`. `--json '{"deviceId":"<deviceId>","bytes":null}'` puts the default,
  64 GB, back.
- **Music.** With `$S ios up --app music`, `$S ios open /settings/downloads` shows `Download
  quality` (`Lossless, Original file · ~35 MB a song` and `High, AAC · 320 kbps · ~10 MB a song,
  selected`), `Storage` with `Nothing downloaded` and the free space, and `Remove all downloads`.
  With Prisma's id from `$S cli -- music albums list`, `$S ios open /album/<albumId>` has the
  button `Download` in the top bar; after `$S ios tap --label Download` it reads `Cancel download,
  <n> of 11 songs downloaded`, then `Downloaded. Remove download`, within a minute.
- **Music, offline.** `$S ios offline on`, then tap the album's `Play` by the point `$S ios find
  Play` prints: the mini player reads `Now playing: Hoist, Andy G. Cohen` with `Pause`, and in Now
  Playing `Position` advances. `$S cli -- music history list` doesn't list `Hoist` yet; after
  `$S ios offline off` it lists it first, within a few seconds.
- **Music, remove all.** `/settings/downloads` reads `11 songs · 80 MB` under `Storage`.
  `$S ios open /settings/downloads/remove-all` asks `Remove all downloads?` with `Remove 80 MB` and
  `Keep downloads`; `$S ios tap --label "Remove 80 MB"` leaves `Nothing downloaded`, and the
  album's button reads `Download` again.
- **Proof.** `$S ios shot captures/verify/<run>/after/downloads/movies-downloads.png` on the
  Downloads tab with the download ready, and `$S ios describe` beside it.

## Gotchas

- Metro and the server each have an ssh forward of their own. `ios offline on` stops the
  server's alone, so the dev client keeps its code, and `ios offline off` starts whichever isn't
  running, which also repairs a forward the Mac dropped.
- `ios open` puts a screen on top of the one before, so `ios describe` lists both. Read the last
  matching lines, and tap a button two screens share by point.
- A CLI session is on no device until `auth registry enroll`, which no seeded person's CLI has
  done. Its device code signs that device in again: keep `enroll`'s output in a file.
- `auth downloads add` reserves the item for the device and counts its size at once; it copies
  nothing to the machine the CLI runs on.
- A Mac busy with someone else's build drops the ssh forward and taps: a download then sits on
  `Cancel download, waiting to download` or `waiting for a connection to the server`. Check
  `$S ios doctor`, run `$S ios offline off`, and try again before you call it a bug.
- One side holds one simulator: `ios down`, then `ios up --app music`, to change apps.
- The simulator is the Mac's disk. A movie download is the size its row shows.
