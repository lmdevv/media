# Connect

A person moves music between their own devices and controls one from another, as old music's
"Play on" did: a pause in one browser pauses the song in another, a move continues the song there
at the same place, and an album's menu plays the album on another device. The list holds only the
person's own devices that are online (ADR 0018).

## Sub-features

- `connect-picker` lists the person's devices in "Play on": the desktop popover, the phone sheet,
  and the dialog the `d` key or the command menu opens.
- `connect-remote` follows and controls the device that plays: the player bar's band
  `Playing on <device>`, its `On <device>` badge, the phone mini
  player, and Now Playing's pill.
- `connect-move` moves playback to another device, or back with `This browser`.
- `connect-load` plays an album on another device from the album's `More actions` menu,
  `Play on`.
- `connect-cli` controls a device from the terminal.

## How to get to it (user POV)

- Desktop web: the player bar's speaker button `Play on another device`, the `d` key, or the
  command menu's `Play on another device…`.
- Phone web: the mini player, then Now Playing's `Play on another device. Now: <device>` button.
- An album's `More actions for <album>` menu, then `Play on` and a device.
- Terminal: `media auth targets list`, `media auth targets control --device-id <id> --playing false`,
  `media auth targets load`, and `media auth targets move`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the demo library.
- Two pages signed in as one person, each its own device, such as
  `$S browser sign-in --app music --page aiko-desk --username aiko` and
  `$S browser sign-in --app music --page aiko-phone --device "iPhone 15" --username aiko`. The
  account client names them `Chrome on Linux` and `Safari on iPhone`.

- **Play on one.** Open `/albums/<id>` on `aiko-desk`, click
  `--role button --name Play --exact --in main`, and `wait-audio --past 3`.
- **Follow it on the other.** `$S browser --page aiko-phone open /`. The mini player reads
  `Open Now Playing: <song>, playing on Chrome on Linux`.
- **Pause it remotely.** Click the mini player's `Pause` on `aiko-phone`; `$S browser --page
  aiko-desk audio` prints `"playing":false` within a quarter second. To time it, attach a `pause`
  listener to `window.mediaVerifyMedia` on the target with `eval --js`, and record `Date.now()` on
  the controller just before its click: both pages share Chromium's clock.
- **Move it.** On `aiko-desk`, click `Play on another device`, then
  `--role menuitemradio --name "Safari on iPhone"`. `aiko-phone` plays on at the desk's position
  (`wait-audio --advance 1`), the desk's audio stops, and its bar shows the band
  `Playing on Safari on iPhone`.
- **Seek it.** On the controller, click the `Seek` slider's control two thirds along on a 3-minute
  song; the target's `audio` reads about 2 minutes.
- **Load an album there.** On the controller's album page, open `More actions for <album>`, then
  `Play on` and the device. The target plays the album's first song.
- **Another person.** As Sam, `d` opens a list with only `This browser` and
  `No other devices right now`. As Mateo, `$S cli --as mateo -- auth targets control --device-id
  <Aiko's device> --playing false` exits 5 (notFound), and `auth targets list` is empty.
- **Take over in a second tab.** While `aiko-desk` plays, open another tab of it with
  `$S browser --page aiko-desk-2 --tab-of aiko-desk open /albums/<id>` and play there. The new tab
  speaks for the browser's device, and the first tab's `audio` reads `"playing":false`. A pause
  from `aiko-phone` then pauses the new tab, and the first stays silent.
- **Gone.** Close the target page (`close-page`). Within about 35 seconds its row leaves the
  controller's list, and the band goes.
- **Proof.** Record the controller with `record-start --show-actions`, take stills of both pages,
  and save `delay.txt` with each pause's delay.

## Gotchas

- The pages of one browser context share one device, and only one tab of a browser reports for
  it: the one that played last, and the tab it took over from stops. Use a page per device.
- The before side has no Connect in `/music` before p6-connect-web.
- A target the browser never let play sound may refuse to start a load; the browser host launches
  Chromium so that it can.
