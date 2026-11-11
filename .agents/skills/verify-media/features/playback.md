# Playback

A user plays a movie or an episode and the video really plays: the browser plays the original file
when it can (direct play), and otherwise an HLS stream that the media service makes on demand,
with only the audio transcoded, the file remuxed, or the whole video transcoded. A title with
progress offers to resume where the person (the profile in old movies) stopped.

## Sub-features

- `play-direct` plays an MP4 that the browser can decode as the original file.
- `play-hls-audio` plays Sintel's MKV as HLS with its AC3 5.1 audio transcoded.
- `play-transcode` plays Caminandes' VP8 and Vorbis episodes as HLS with the video transcoded.
- `play-resume` resumes a half-watched title from Continue watching.
- `play-controls` pauses, seeks, and leaves the player.
- `play-ios` plays a title in the iOS app (old movies only, until the app moves to the core).

## How to get to it (user POV)

- Desktop and phone web: a title's page, then `Play` (`Play S1:E1` on a show), or the featured
  title's `Play` on Home.
- A `Resume …` card in the `Continue watching for <username>` row on Home.
- The player at `/watch/<id>`: `Pause`/`Play`, `Back 10 seconds`, `Forward 10 seconds`, the `Seek`
  slider, `Audio, subtitles, and quality`, `Watch together`, `Full screen`, and `Back to details`.
- Terminal: `media movies play start --title-id <id>` takes a play ticket on the core; in old
  movies `media play <title>` prints a stream URL for mpv or VLC.
- iOS app: a title, then `Play`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed.

- **Direct play.** Run `$S browser open /`,
  `$S browser click --role link --name "New Big Buck Bunny" --in region="Recently added"`, then
  `$S browser click --role link --name Play --exact --in main` and
  `$S browser wait-video --past 3`. It prints `"playing":true`, `"source":"file"`,
  `"size":"640x360"`, and `"requests":{"direct":1,"hls":0}`. Then
  `$S logs 200 | grep Stream.started | tail -1` shows `"mode":"direct"`.
- **HLS, audio transcoded.** Open Sintel (`$S browser open /movies`, then
  `$S browser click --role link --name "Sintel 2010" --in main`), click `Play` as above, and run
  `$S browser wait-video --past 4 --timeout 60000`. It prints `"source":"mse"`,
  `"size":"1920x818"`, and HLS requests above zero. The log shows `"mode":"audio-transcode"`.
- **HLS, video transcoded.** Open Caminandes from `/shows`, run
  `$S browser click --role link --name "Play S1:E1" --in main` and
  `$S browser wait-video --past 4 --timeout 90000`. It prints `"source":"mse"` and
  `"size":"1365x720"`. The log shows `"mode":"transcode-software"`.
- **Resume.** As Aiko: `$S browser sign-in --page aiko --username aiko` (in old movies,
  `--email aiko@movies.local --profile Aiko` and the row `Continue watching for Aiko`), then
  `$S browser click --page aiko --role link --name "Resume Elephants Dream" --in region="Continue watching for aiko"`.
  The player asks `Welcome back, aiko` with `5:29 / 10:58`. Run
  `$S browser click --page aiko --role button --name "Resume from"` and
  `$S browser wait-video --page aiko --past 331`. Seconds start above 329; the log shows
  `"mode":"remux"`.
- **Pause.** Run `$S browser hover --testid player-video`, then
  `$S browser click --role button --name Pause --exact`. `$S browser video` prints
  `"playing":false`, and its seconds stay put on a second read.
- **Leave.** Run `$S browser hover --testid player-video` and
  `$S browser click --role button --name "Back to details"`. The title's page shows the links
  `Resume <time>` and `Play from start` instead of `Play`.
- **CLI.** On `one-backend`, run `$S cli -- movies play start --title-id <id>` with Big Buck
  Bunny's id from `$S cli -- movies titles search --query "Big Buck Bunny"`. It prints the file,
  `resumePositionMs`, and a `ticket` for the media service. In old movies, `$S cli -- play "Big
  Buck Bunny"` prints JSON with `"mode": "direct"` and a `url` on the side's media address
  (`/media/direct/<file>?token=…`); `curl -s -r 0-1000 <url>` answers `206` with `video/mp4`.
- **iOS.** On a `one-port` side only: after `$S ios up`, Home features Pioneer One. Run `$S ios tap --label "Play S1:E1"` and
  wait a few seconds. The player hides its controls, so `$S ios tap -x 400 -y 200` (landscape)
  shows them; `$S ios describe | grep 'Playback position'` prints `Playback position = 0:20 of
  31:36`, and a second read a few seconds later prints a later time. The log shows
  `"mode":"direct"`. Close the player with `$S ios tap --label Close` while the controls show.
  Record with `$S ios record start <path.mp4>` and `$S ios record stop`.
- **Proof.** Record with `$S browser record-start --path captures/verify/<run>/after/playback/sintel.mp4`
  before the first click and `$S browser record-stop` after `wait-video`. Take the still with
  `$S browser screenshot --path captures/verify/<run>/after/playback/player.png` while the
  controls show.

## Gotchas

- While the video plays, the player hides its controls, and the video element takes clicks.
  Hover `--testid player-video` before each control click, or the click times out on
  `<video> intercepts pointer events`.
- `wait-video` reads the page's own media elements. `"elements":0` means the page has no player:
  it's still on the title page, or `Play` was a link that hasn't loaded.
- A `Continue watching` card for a movie with progress can open on `Welcome back, <profile>`
  instead of playing. Pick `Resume from …` or `Start from beginning` first. The title page's
  `Resume <time>` link plays at once.
- The first HLS request runs ffmpeg; Caminandes takes a few seconds before `currentTime` moves.
  Give `wait-video` a timeout of a minute or more.
- `HardwareAcceleration.unavailable` warnings in `$S logs` are expected on a host without a GPU;
  the service falls back to `transcode-software`.
- Playback changes the person's progress (the profile's in old movies), so later recipes see
  `Resume` on that title.
- On iOS, the Continue Watching cards past the screen edge can't be tapped until the row is swiped
  (`$S ios swipe 350 729 80 729`), and the posters in `Recently Added` and the Search rows have no
  accessibility labels, so reach a title through Home's featured title or Continue Watching.
