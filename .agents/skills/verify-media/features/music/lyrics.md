# Lyrics

A listener reads a song's lyrics in Now Playing. Timed lyrics follow the song line by line, and a
click on a line plays from there; plain lyrics show as text. Lyrics come from a file beside the
song or from its tags, and for a song with none an owner or admin can let the server look them up
on LRCLIB.

## Sub-features

- `lyrics-timed` shows timed lyrics, marks the line that plays, and seeks from a line.
- `lyrics-plain` shows plain lyrics as text.
- `lyrics-none` says a song has no lyrics.
- `lyrics-cli` reads a song's lyrics from the terminal.
- `lyrics-lookup` turns online lookups on or off, and looks every song up at once.

## How to get to it (user POV)

- Music web: the player bar's `Open Now Playing`, then `Lyrics` in the `Now Playing` dialog. With
  the lyrics open the button reads `Hide lyrics`; for a song with none it reads `No lyrics for this
  song` and is disabled.
- The account client's Admin, Libraries: the switch `Look up lyrics online`.
- Terminal: `media music lyrics get --track-id <id>`, and for owners and admins
  `media music lyrics status|configure|backfill`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, with `ok    /music is the music client`, and the side holds the seed.
- Songs with lyrics. The demo library's have none, so run `$S lyrics-probe`, which makes
  `/media/lyrics-probe` inside the side's container, with two 40-second songs by `Verify Media`:
  `Timed Probe`, with four timed lines at 0:00, 0:05, 0:10, and 0:20, and `Plain Probe`, with two
  plain lines. Add that folder as a library of kind `Music` named `Lyrics probe`, as in
  [Music library](./library.md), and wait for its page to read `Scanned`.

- **Read.** With the song's id from `$S cli -- music library search "Timed Probe"`
  (`tracks[0].id`), `$S cli -- music lyrics get --track-id <id>` prints `"status": "synced"`,
  `"source": "file"`, the file `01 Timed Probe.lrc`, and each line's `text` and `startMs`. For
  `Plain Probe` it prints `"status": "plain"`, and for a demo song, such as `Wanderer`,
  `{"status": "none"}`.
- **Timed.** Run `$S browser --app music open /search`,
  `$S browser --app music fill --role searchbox --name "Search your library" --value "Timed Probe"`,
  `$S browser --app music wait --role heading --name "Top result"`, and
  `$S browser --app music click --role button --name "Play Timed Probe" --nth 0`. Then
  `$S browser --app music click --role button --name "Open Now Playing"` and
  `$S browser --app music click --role button --name Lyrics --exact`. The region `Lyrics` lists
  the buttons `First line, seek to 0:00` to `Fourth line, seek to 0:20`.
- **Follow.** After `$S browser --app music wait-audio --past 6`,
  `$S browser --app music attr --css '[aria-label="Lyrics"] button[aria-current="true"]' --attr aria-label`
  prints `Second line, seek to 0:05`.
- **Seek.** `$S browser --app music click --role button --name "Fourth line, seek to 0:20"`: `audio`
  reads just past 20 seconds, and the current line is the fourth.
- **Plain and none.** Press `Escape`, play `Plain Probe` the same way, and open its lyrics: the
  region reads `A plain first line A plain second line`, with no buttons. With `Wanderer` playing,
  Now Playing has the disabled button `No lyrics for this song`.
- **iOS.** With `$S ios up --app music` and the probe album's id from `$S cli -- music albums
  list`, `$S ios open /album/<albumId>`, `$S ios tap --label "Timed Probe, Verify Media"`, and
  `$S ios tap --label "Now playing: Timed Probe, Verify Media"`. The cover is the button `Lyrics`;
  after `$S ios tap --label Lyrics`, `$S ios describe` lists the buttons `First line` to `Fourth
  line` above `Position`.
- **Lookups.** `$S cli -- music lyrics status` prints `"remote": true`, and
  `$S cli --as aiko -- music lyrics status` exits 4. In the account client, on `/admin/libraries`,
  `$S browser click --page owner --role switch --name "Look up lyrics online"` turns it off:
  `status` prints `"remote": false`, and `$S cli -- music lyrics backfill` exits 6 with `Lyrics
  lookups on LRCLIB are off`. `$S cli -- music lyrics configure --remote` turns it on again, and
  `backfill` prints the number of `libraries` it queued; `$S cli -- admin jobs list` then lists a
  `music.lyrics` job per song, which for a demo song ends with `LRCLIB has no lyrics for the
  song`.
- **Proof.** `$S browser --app music screenshot --path captures/verify/<run>/after/music/lyrics/timed.png`
  with the lyrics open, and `$S browser --app music snapshot --in region=Lyrics --path
  captures/verify/<run>/after/music/lyrics/timed.aria.txt`.

## Gotchas

- The `Lyrics probe` library is Lucía's alone until it is shared, so another person's
  `music lyrics get` for its songs exits 5. Its songs show in her search, Songs page, and counts:
  remove the library from its page in the account client before a recipe that counts songs.
- A lookup needs the internet from the container, and finds nothing for the demo songs or the
  probe's. Proving a found lookup needs a song LRCLIB knows, in a library of your own
  (`up --library DIR`).
- A backfill's jobs join Admin, Jobs, a job per song.
- `Lyrics` needs `--exact`: `Hide lyrics` and `No lyrics for this song` hold the same word.
