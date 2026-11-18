# Casting

Chromecast from `/movies` and `/music` to Google's default receiver, and AirPlay from the movies
and music iOS apps (ADR 0018, "Casting as built"). A receiver's URLs carry a receiver credential in
place of the start's ticket (ADR 0011). Verify-media has no Chromecast, so a page made with
`--cast-fake` gets the scripted one the Playwright suites cast to, named `Living Room TV`, which
fetches what it is told to play from the side as a receiver does.

## Movies: cast a title

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

Pass: `Playing on Living Room TV` shows over the frame, the page's video pauses, and `cast-state`
shows one load whose `contentId` carries `ticket=r1.…` (never `t1.`) and fetches answered 200 or
206. A file the Chromecast cannot play (HEVC, an MKV) loads as `application/x-mpegurl`, and
`$S logs | grep Stream.started` shows its `remux` or `transcode-software`. `cast --value disconnect`
continues on the page where the TV was. On a phone-sized page (`--width 393 --height 852`), the
cast button is in the player's top bar.

## Music: cast a song, and see it from another device

```sh
$S browser sign-in --app music --page laptop --username aiko --cast-fake
$S browser sign-in --app music --page desk --username aiko
# Play a song on laptop, then:
$S browser cast --value devicesAppear --page laptop
$S browser click --role button --name "Play on another device" --page laptop
$S browser click --role menuitem --name Chromecast --page laptop
$S browser cast-state --page laptop
$S browser click --role button --name "Play on another device" --page desk
$S browser snapshot --in menu="Play on" --page desk
$S browser click --in region=Player --role button --name Pause --exact --page desk
$S browser cast-state --page laptop
```

Pass: laptop shows `Playing on Living Room TV`; its load is the song at `p=aac-320` for a FLAC
(`audio/mp4`) or `p=original` for an MP3 (`audio/mpeg`), with `ticket=r1.…`; desk's list shows
laptop's row as `Casting to Living Room TV`; desk's Pause leaves `cast-state`'s `isPaused` true.

## Signing out ends the cast

End the casting browser's session from another device (`$S cli -- auth sessions list`, then
`auth sessions end --session-id <id>`), and fetch the last URL `cast-state` lists: it answers 410
for a song, and a refusal for a movie whose stream ended with the session.

## AirPlay on iOS

Open the player (movies) or Now Playing (music) and tap the `AirPlay` button: the system's route
picker opens over the app and the music or movie keeps playing until a route is chosen. A
simulator lists no receivers; a real one is the owner's check.

## Gotchas

- The scripted Chromecast lives in the page: a full page load (`open`) starts it over,
  disconnected, so cast again after one.
- Headless Chromium's own user agent has no `Chrome/` token, and the clients load the Cast SDK
  only for Chromium browsers, so a `--cast-fake` page gets desktop Chrome's agent. A phone page
  (`--device "iPhone 15"`) keeps the iPhone's, which never casts.
- The stack answers on `localhost`, so the Play on menu notes that a real Chromecast could not
  reach it. The scripted one runs in the page and reaches it.
