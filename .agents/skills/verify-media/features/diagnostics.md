# Diagnostics

A person finds out why playback went the way it did. The player's `Stream info` panel says how the
stream in front of them plays, and the `media` CLI reads the media service's retained log: `logs`
for the records themselves, `diagnostics sessions` for the playback sessions the log mentions, and
`diagnostics playback` for one session's timeline, with what the server did and what the player
reported side by side.

## Sub-features

- `stream-info` shows the playing stream's mode, video, audio, container, and bitrate in the
  player, and for a transcode where each stage runs and any change of its chain after a failure.
- `diag-sessions` lists playback sessions, newest first: everyone's for an owner or admin, a
  member's own for a member.
- `diag-playback` prints one session's timeline: the stream's start and why it ended, the player's
  startup, stalls, errors, and recoveries, and what evidence is missing.
- `logs-read` prints the retained log, filtered by time, level, session, stream, text, or slowness.
- `logs-follow` keeps printing new records.
- `diag-access` refuses a member the log, and hides other people's sessions from them.
- `app-events` writes each iOS app's launches, screen opens, and unexpected errors to the log as
  `App.launched`, `App.screenOpened`, and `Client.error`; the skill's [App timings](../SKILL.md#app-timings)
  says how `ios timings` and `ios force-error` drive and read them.

## How to get to it (user POV)

- Movies web: the player's `Stream info` button in the top bar.
- Terminal: `media diagnostics sessions`, `media diagnostics playback <session-id>`, and for
  owners and admins `media logs`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed.
- A playback session in the log: as Lucía, play Sintel as in [Playback](./playback.md)
  (`wait-video --past 4`), then leave with `hover --testid player-video` and
  `click --role button --name "Back to details"`, which ends the stream.

- **Stream info.** While Sintel plays, run `$S browser hover --testid player-video` and
  `$S browser click --role button --name "Stream info"`. The region `Stream info` holds the list
  `Playback mode` (`Direct`, `Remux`, `Transcode`) and the terms `Video` (`H.264 · 818p · SDR`),
  `Audio` (`AAC 2.0 · converted`), `Container` (`MKV → HLS fMP4`), and `Bitrate`. A transcode
  adds `Stages`, one line per stage with where it ran (`Decode · QSV`, `Move · QSV → CPU`,
  `Encode · CPU`), and after a failure `Changed` (`21:04 · probe failed too · tonemap.qsv`). `Close
  stream info` closes it.
- **Sessions.** `$S cli -- diagnostics sessions` prints a JSON list, newest first; the first entry
  has a `sessionId`, Lucía's `userId`, `"platform": "web"`, and `"warnings": 0`. `--human` prints
  one line per session.
- **Timeline.** `$S cli -- diagnostics playback <sessionId>` prints `counts` (`"streams": 1`, no
  stalls or failed requests), `drift` (`not-measured` for a play under 10 seconds), and `entries`:
  `stream-started` with `HLS stream started (audio-transcode)`, `player-attached`, `startup` with
  the time to the first frame, and `stream-ended` with `Stream ended: stopped, the player stopped
  it`. `--human` prints the same as a dated summary and one line per entry.
- **Log.** `$S cli -- logs --since 10m --limit 3` prints the last three records as
  `<time> <level> <message> key=value…`, after the note `Older records may match too` when more
  match. `--json` prints each record as one JSON line. `--session-id <sessionId>` keeps that
  session's records, from `Stream.started` to `Stream.ended`; `--grep Stream.started` keeps
  records with that text; `--slow 200ms` keeps timed records at least that long; `--level warn`
  prints nothing on a clean run.
- **Follow.** Run `timeout 40 $S cli -- logs --follow --since 1s` in the background, with its
  output in a file, and meanwhile play a title past 4 seconds and leave it: the file gains that
  play's `Player.startup_ended` and `Stream.ended` records as they are logged, and the command
  exits 124 when its time is up. Give it the whole play and ten seconds more, since the player's
  records arrive late.
- **Access.** `$S cli --as mateo -- logs --since 10m --limit 1` prints a record, since Mateo is an
  admin. `$S cli --as aiko -- logs --limit 2` exits 4 with `Only an owner or an admin may do
  this`. `$S cli --as aiko -- diagnostics sessions` prints `[]` until Aiko plays something, and
  `$S cli --as aiko -- diagnostics playback <Lucía's sessionId>` exits 5 with `No playback records
  for session …`, as does a session id that doesn't exist.
- **Proof.** Save `$S cli -- diagnostics playback <sessionId> --human` to
  `captures/verify/<run>/after/diagnostics/playback.txt`, and take
  `$S browser screenshot --path captures/verify/<run>/after/diagnostics/stream-info.png` with the
  panel open.

## Gotchas

- The commands read the log over the network, as the person's CLI session, so they run from the
  host through `$S cli` like any other command.
- `diagnostics playback` prints JSON unless `--human` is given; `logs` prints lines unless `--json`
  is.
- A session shows once the media service has logged it. The player's own records arrive a few
  seconds after they happen, in batches.
- `$S logs` is the container's whole output, Convex's included. `$S cli -- logs` is the media
  service's retained log alone.
- A session id is not a secret, but a log line can carry a file's name and a person's id. Keep
  whole logs out of a PR.
