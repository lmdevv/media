# Fix match

An owner, or anyone who manages a library, corrects what a file was matched to: they look the
title up, pick the right film or show, or type its name, year, and TMDB ID by hand, and can ask
for its details again. The movies app's own Libraries pages list each library's files with what
they matched, and the CLI's `movies metadata` group edits, matches, and refreshes a title.

## Sub-features

- `match-files` lists a library's files with their quality, size, and `Matched`, `Unmatched`, or
  `Missing`.
- `match-edit` changes a title's name, year, or other fields by hand, and clears a change to bring
  the scanned value back.
- `match-search` looks a title up on TMDB and applies the chosen match. It needs a TMDB key.
- `match-refresh` queues a metadata lookup for a title.
- `match-access` refuses a person without edit access to the library.

## How to get to it (user POV)

- Movies web: the command menu's `Libraries`, or `/admin/libraries`, then a library. A file that
  is `Unmatched` has a `Fix match` link, to `/admin/libraries/<library>/match/<title>`.
- `Manage in account` on those pages opens the account client, which owns a library's name,
  folders, sharing, and removal.
- Terminal: `media movies metadata edit|match|refresh`.
- iOS movies app: You, `Owner Settings`, `Libraries`, a library, `Unmatched Files`, then a file.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed. The demo's
  `[movies] Feature Test` is unmatched, with four files; the other titles are matched.

- **Files.** Run `$S browser open /admin/libraries` and
  `$S browser click --in table=Libraries --role link --name Movies --exact`. The heading `Movies`
  reads `/media/library/Movies · 6 titles`, the radios `Show` read `All`, `Missing 0`, and
  `Unmatched 1`, and the table `Files` has a row per file, such as `Sintel (2010) Sintel
  (2010).mkv 720p · H.264 1.2 GB Matched`. `$S browser click --role radio --name Unmatched` keeps
  the Feature Test's four files, each `Unmatched best guess · [movies] Feature Test (2010)` with
  a `Fix match` link.
- **Open.** `$S browser click --in table=Files --role link --name "Fix match" --nth 0`. The heading
  `Fix match` reads `Film · … · 4 versions`, the region `Matched to now` reads `No match`, and
  without a TMDB key the status reads `TMDB search isn’t available on this server` and `Edit the
  title, year, or TMDB ID by hand below.` `$S browser url` ends in the title's id.
- **Edit by hand.** Run `$S browser fill --label Title --value "Match probe"` and
  `$S browser click --role button --name "Apply match" --exact`. The page goes back to the
  library with the toast `Saved Match probe`; `$S cli -- movies titles get --title-id <id>` prints
  `"name": "Match probe"`, and `/title/<id>` is headed `MATCH PROBE`.
- **Put it back.** `$S cli -- movies metadata edit --json
  '{"titleId":"<id>","set":{},"clear":["name"]}'` prints `null`, and the name reads
  `[movies] Feature Test` again. With flags, `--title-id <id> --set '{"overview":"Probe"}'` sets a
  field and `--set '{}' --clear overview` clears it.
- **Refresh.** `$S cli -- movies metadata refresh --title-id <id>` prints a `jobId`. Without a
  TMDB key, `$S cli -- admin jobs list` then shows that `movies.metadata` job `"failed"` with
  `Metadata provider unavailable: tmdb (missing-credentials)`, and the title keeps its details.
- **Access.** `$S cli --as aiko -- movies metadata edit --title-id <id> --set '{}' --clear
  overview` exits 4 with `This needs edit access, and you have view`. As Mateo, who manages the
  library, the same command prints `null`.
- **Proof.** `$S browser screenshot --path captures/verify/<run>/after/fix-match/fix-match.png` on
  the Fix match page, and the title's page after the edit.

## Gotchas

- A side has no TMDB key: `up` hands Compose only the settings it writes. So `Search TMDB` finds
  nothing, `match-search` can't run, and a refresh fails. Hand edits and their clearing work.
- `metadata edit` needs `--set` even to clear: pass `--set '{}'` with `--clear`.
- A failed refresh adds to Admin, Jobs' `Failed` count for the rest of the side's life. Run it
  after any recipe that reads that count.
- `Fix match` shows only on unmatched files, and each of a title's files has its own link to the
  same page. Use `--nth 0`.
- The page has two `Year` fields, the search's and the hand edit's. Pick one with `--nth`.
- A title's heading is its name in capitals, as on any title's page.
