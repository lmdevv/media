# Music library

An owner adds a music library from the account client at `/`, the one sign-in for every app. Its
first scan runs in the background, and `/music` then opens with the scanned albums and their art,
with no sign-in of its own.

## Sub-features

- `library-add` adds `/media/library/Music` as a library of kind Music.
- `library-scan` runs the real scanner over it.
- `library-open` opens `/music` signed in with the owner's session, with the scanned albums.
- `library-cli` lists the albums from the terminal.

## How to get to it (user POV)

- The account client's Admin, Libraries (`/admin/libraries`) and its `Add a library` form, with
  `Kind` set to `Music`.
- `/music`, which uses the sign-in the account client keeps.
- Terminal: `media music albums list`.

## Driving it with verify-media

Preconditions:

- A side started with `$S up --no-seed`, or `$S up --no-setup` and then the owner step of
  [first-run setup](../first-run-setup.md), so Lucía exists. With `--no-seed`, `up` already added
  the `Music` library; read it instead of adding it.

Use an account page, `--app account --page owner`, for the account steps:

- **Library.** Run `$S browser sign-in --app account --page owner`, then
  `$S browser open --page owner /admin/libraries`,
  `$S browser fill --page owner --in region="Add a library" --label Name --value Music`,
  `$S browser select --page owner --in region="Add a library" --label Kind --value Music`,
  `$S browser fill --page owner --in region="Add a library" --label "Folders, one per line" --value /media/library/Music`,
  and `$S browser click --page owner --in region="Add a library" --role button --name "Add library"`.
  The `Libraries` list gains the link `Music`.
- **Scan.** Open the `Music` link. Its page reads `Scanned <time>` once the scan ends. Then
  `$S cli -- auth libraries get --library-id <id>` shows `"scan": {"status": "succeeded", …}`.
- **Open.** Run `$S browser sign-in --app music --page owner-music`: it signs in at `/` and opens
  `/music` with that session. `$S browser wait --page owner-music --role heading --name "Recently added"`
  succeeds, with album art under it.
- **CLI.** `$S cli -- music albums list` lists the 5 demo albums in `page`.
- **Proof.** `$S browser screenshot --page owner-music --path captures/verify/<run>/after/music/library/home.png`
  and `$S browser snapshot --page owner-music --in main --path captures/verify/<run>/after/music/library/home.aria.txt`.

## Gotchas

- `up` adds the `Music` library itself unless it ran with `--no-setup`. A second library over the
  same folder shows each album twice.
- A library is private to whoever made it until it is shared (`music-core-seed.mjs` shares it).
  Before that, only Lucía sees the albums.
- The demo library scans in seconds. Lyrics are not looked up on scan; an owner or admin starts
  that with `media music lyrics backfill`.
