# Connect

A person moves music between their own devices and controls one from another: a pause in one
browser or the music iOS app pauses the song on another device, a move continues the song there
at the same place, and an album's menu plays the album on another device. The list holds only the person's own devices that are online (ADR 0018).

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
- `connect-ios` does all of the above in the music iOS app: its device sheet, the remote control
  of another device from the mini player and Now Playing, moves to and from the phone, an
  album's `Play on`, and the phone as a target the browser pauses and moves to.

## How to get to it (user POV)

- Desktop web: the player bar's speaker button `Play on another device`, the `d` key, or the
  command menu's `Play on another device…`.
- Phone web: the mini player, then Now Playing's `Play on another device. Now: <device>` button.
- An album's `More actions for <album>` menu, then `Play on` and a device.
- Terminal: `media auth targets list`, `media auth targets control --device-id <id> --playing false`,
  `media auth targets load`, and `media auth targets move`.
- iOS app: Now Playing's device button (`This iPhone`, or `Playing on <device>` while another
  device plays), the iPad player bar's speaker button, and Settings, `Devices`, each open the
  `Play on` sheet. An album's `Album actions` sheet has `Play on`.

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
- **The phone.** Run `$S ios up --app music --udid <id> --no-sign-in` on the simulator T3's device
  tools opened, open the printed link with agent-device, and sign in as `aiko`. The phone's device
  has the name iOS gives it (`iPhone 18 Pro` on that simulator). With `aiko-desk` playing, the app's
  mini player follows it, and Now Playing's button reads `Playing on Chrome on Linux`; its Pause
  pauses the desk. The button opens `Play on`: `This iPhone` moves the song to the phone at the
  desk's position, and the sheet closes once the phone plays. From the desk, `Play on another
  device`, then the phone, moves it back, and the bar's Pause then pauses the phone. An album's
  `Album actions`, then `Play on`, then `Chrome on Linux` plays the album on the desk. As Sam the
  sheet holds only `This iPhone` (or `This iPad`) and `No other devices right now`.
- **A move that never lands.** With the phone playing, close the desk's page (`close-page`) and,
  within 20 seconds, while the core still counts its last report, pick `Chrome on Linux` in the
  phone's `Play on`. The core takes the move and the phone stops, but nothing loads it: the sheet
  reads `Moving to Chrome on Linux`, and 10 seconds after the tap `Couldn’t reach Chrome on Linux`
  with `Try again` and `Stay here`, which stay once the desk leaves the list.
- **Time a remote pause to the phone.** The phone's clock is the Mac's: take its offset from this
  host over one long ssh session (the shortest of many round trips to one remote process), record
  `Date.now()` before each click on the desk, and read when the app's AVPlayer paused from the
  Mac's unified log: `xcrun simctl spawn <udid> log show --style ndjson --predicate 'process ==
  "music" AND eventMessage CONTAINS "timeControlStatus"'`, whose `setting timeControlStatus=0`
  lines are the pauses. For the reverse, the desk's `connectRequests` row holds the server time
  its `control` applied (`ask.at`), the clock of the desk's `Date.now()`.

## Gotchas

- The pages of one browser context share one device, and only one tab of a browser reports for
  it: the one that played last, and the tab it took over from stops. Use a page per device.
- A target the browser never let play sound may refuse to start a load; the browser host launches
  Chromium so that it can.
- An iOS simulator can't press the lock screen, Control Center, or headphones.
  `scripts/ios-remote-command.m` sends MediaRemote's play, pause, toggle, next, and previous
  inside the simulator as they do, which agent-device can't. Copy it to the Mac's
  `~/music-ios/tools/` and build it there with `xcrun -sdk iphonesimulator clang -arch arm64
  -mios-simulator-version-min=17.0 -fobjc-arc -framework Foundation ios-remote-command.m -o
  ios-remote-command`, then run `xcrun simctl spawn <udid> ~/music-ios/tools/ios-remote-command pause`.
- In Now Playing, snapshot marks the controls `[covered]` and ref taps don't land: tap by point.
- A killed app leaves the list about 35 seconds after its last report. iOS suspends a backgrounded
  app that plays nothing on a real phone, which then leaves the same way; a simulator keeps it
  running, so it stays listed there.
