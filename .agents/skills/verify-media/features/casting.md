# Casting

A user sends what plays to a TV: Chromecast from `/movies` and `/music` to Google's default
receiver, and AirPlay from the movies and music iOS apps (ADR 0018, "Casting as built"). The
receiver's URLs carry a receiver credential in place of the start's ticket (ADR 0011). Verify-media
has no Chromecast, so a page made with `--cast-fake` gets the scripted one the Playwright suites
cast to, named `Living Room TV`, which fetches what it is told to play from the side as a receiver
does.

## Sub-features

- `cast-movie` casts a title from the movies player and pauses the page's own video.
- `cast-resume` continues on the page where the TV was when the cast ends.
- `cast-song` casts a song from `/music`'s "Play on".
- `cast-remote` shows the cast on the person's other devices and lets them pause it.
- `cast-sign-out` ends the cast's access when its session ends.
- `cast-airplay` offers the system's route picker in the movies and music iOS apps.

## How to get to it (user POV)

- Movies web: the player's `Cast` button in the top bar, then `Chromecast` in `Play on`.
- Music web: the player bar's `Play on another device`, then `Chromecast`.
- Another of the person's devices: `Play on another device` lists the casting browser as
  `Casting to <TV>`.
- iOS: the `AirPlay` button in the movies player and in music's Now Playing.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library and the seed.
- Big Buck Bunny's id, from `$S cli -- movies titles search --query "Big Buck Bunny"`.

- **Cast a title.** Run these in order:

  ```sh
  $S browser sign-in --page tv --cast-fake
  $S browser open "/watch/<Big Buck Bunny id>?start=0" --page tv
  $S browser wait-video --past 2 --page tv
  $S browser cast --value devicesAppear --page tv
  $S browser hover --testid player-video --page tv
  $S browser click --role button --name Cast --exact --page tv
  $S browser click --in dialog="Play on" --role button --name Chromecast --page tv
  $S browser wait --testid casting-state --page tv
  $S browser cast-state --page tv
  ```

  `$S browser text --testid casting-state --page tv` reads `Playing on Living Room TV`, the
  page's `video` prints `"playing":false`, and `cast-state` shows `"castState":"CONNECTED"` and
  one load whose `contentId` carries `ticket=r1.…` (never `t1.`), with `contentType` `video/mp4`
  and fetches answered 200 or 206. A file the Chromecast cannot play (HEVC, an MKV) loads as
  `application/x-mpegurl`, and `$S logs | grep Stream.started` shows its `remux` or
  `transcode-software`.
- **End the cast.** `$S browser cast --value disconnect --page tv`: `casting-state` goes, and
  `$S browser video --page tv` prints `"playing":true` from where the TV was.
- **Cast a song.** Run these, as Aiko on two pages:

  ```sh
  $S browser sign-in --app music --page laptop --username aiko --cast-fake
  $S browser sign-in --app music --page desk --username aiko
  $S browser open /albums --page laptop
  $S browser click --page laptop --role link --name "Vienna Blue" --in main --nth 0
  $S browser click --page laptop --role button --name Play --exact --in main --nth 0
  $S browser wait-audio --page laptop --past 2
  $S browser cast --value devicesAppear --page laptop
  $S browser click --role button --name "Play on another device" --page laptop
  $S browser click --role menuitem --name Chromecast --page laptop
  $S browser cast-state --page laptop
  ```

  The laptop's page shows the status `Playing on Living Room TV`. Its load is the song at
  `p=original` for an MP3 (`audio/mpeg`) or `p=aac-320` for a FLAC (`audio/mp4`), with
  `ticket=r1.…`.
- **See it from another device.** Run
  `$S browser click --role button --name "Play on another device" --page desk` and
  `$S browser snapshot --in menu="Play on" --page desk`: the laptop's row reads
  `Chrome on Windows Casting to Living Room TV · playing`. Close the menu with
  `$S browser press --key Escape --page desk`, then
  `$S browser click --in region=Player --role button --name Pause --exact --page desk` leaves
  `cast-state`'s `isPaused` true on the laptop.
- **Sign out.** Read the last URL in `cast-state`'s `fetches`; `curl -r 0-99` on it answers 206.
  End the casting browser's session as the person who casts, here
  `$S cli --as aiko -- auth sessions list` for the `sessionId` named `Chrome on Windows`, then
  `$S cli --as aiko -- auth sessions end --session-id <id>`. The same URL then answers 410 for a
  song, and a refusal for a movie whose stream ended with the session; the laptop's page goes to
  `/` to sign in.
- **AirPlay.** In the movies iOS app, play a title and show the controls (`$S ios tap -x 400 -y
  200`): `$S ios describe` lists `AirPlay | Button #AirPlay` in the top bar, beside `Close`, and
  music's Now Playing has the same button. On a real device a tap opens the system's route picker
  over the app, and the music or movie keeps playing until a route is chosen.
- **Proof.** `$S browser screenshot --page tv --path captures/verify/<run>/after/casting/movies-cast.png`
  while `casting-state` shows, and save each `cast-state` beside it.

## Gotchas

- The scripted Chromecast lives in the page: a full page load (`open`) starts it over,
  disconnected, so cast again after one.
- Headless Chromium's own user agent has no `Chrome/` token, and the clients load the Cast SDK
  only for Chromium browsers, so a `--cast-fake` page gets desktop Chrome's agent, and the account
  client names its device `Chrome on Windows`. A phone page (`--device "iPhone 15"`) keeps the
  iPhone's, which never casts.
- The stack answers on `localhost`, so the Play on menu notes that a real Chromecast could not
  reach it. The scripted one runs in the page and reaches it.
- `auth sessions list` shows only the caller's own sessions. Run it as the person whose browser
  casts.
- On a phone-sized page (`--width 393 --height 852`), the cast button is in the player's top bar.
- A simulator shows no route picker when `AirPlay` is tapped, and lists no receivers: the movie
  plays on with the controls unchanged. The picker and a real receiver are the owner's check.
