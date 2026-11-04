# Devices

Every signed-in browser and phone is a device. One plays at a time. A user moves playback to
another device, the old one stops, the new one plays, and every device shows where the music is
playing.

## Sub-features

- `devices-list` lists the devices seen in the last day and the one playing.
- `devices-transfer` moves playback to another device, which then plays real audio.
- `devices-remote` shows `Playing on <device>` on a device that is not playing.

## How to get to it (user POV)

- Desktop web: the player bar's devices button opens `Play on`.
- Phone web and the iOS app: the devices button in Now Playing.
- Terminal: `music devices list` and `music playback transfer <deviceId>`.

## Driving it with verify-music

Preconditions:

- `$S doctor` passes, and page `main` plays an album as in [Playback](./playback.md).

- **Second device.** Run `$S browser sign-in --page phone --device "iPhone 15"`. Then
  `$S browser wait --page phone --role button --name "Open Now Playing"` succeeds: the phone
  sees the playback.
- **List.** Run `$S cli -- devices list --json`, an array of devices with `id`, `name`, `kind`,
  and `online`. The phone page is online as `Safari on iPhone`. `$S cli -- now --json` names the active one in `activeDevice`:
  `main`'s `Chrome on Linux`.
- **Transfer.** Take the `id` of the online device that is not `activeDevice`, and run
  `$S cli -- playback transfer <id>`. Then `$S browser audio` prints `"playing":false` for `main`,
  and `$S browser wait-audio --page phone --advance 1` passes.
- **Remote state.** Run `$S browser wait --text "Playing on" --in status`. `main` shows
  `Playing on Safari on iPhone`, the phone page's device name.
- **iOS.** With `$S ios up` ready, the iPhone appears in `$S cli -- devices list --json`.
  Transfer to it and confirm with `$S ios describe`, which shows `Pause` in the mini player.
- **Proof.** Screenshot both pages after the transfer: `$S browser screenshot --path
  captures/verify/<run>/after/devices/main.png` and `$S browser screenshot --page phone --path
  captures/verify/<run>/after/devices/phone.png`.

## Gotchas

- Each `--page` is its own device only after it signs in. Pages share nothing.
- `Playing on …` shows twice on `main`, in the status and in the player bar. Scope it with
  `--in status`.
- A device that closes stays in the list as idle for a while. Use `online` in the CLI's JSON,
  not the count of devices.
- The phone page's `audio` is `"elements":0` until playback moves to it.
