# Jams

People listen together in a Jam, a music group session (ADR 0017). The host
starts one from the song playing; people who open its link listen along to the host's queue and
player, every page in step with the session's clock, and move on to the next song together,
without a gap. The host decides who may join (anyone with the link, approval, or no one new) and
whether guests may add songs and play, pause, skip, and seek.

## Sub-features

- `jam-start` starts a Jam from the song playing, with the queue after it, from the Jam panel's
  `Start a Jam`.
- `jam-join` opens `/music/jam#<link>` (the iOS app: `music://jam/<link>`, or a pasted link) and
  plays in step with the host.
- `jam-approval` holds a person on `Waiting to join <host>'s Jam` until the host's `Let in`.
- `jam-locked` refuses a link with `This Jam is locked`.
- `jam-add` queues a song from a song's `Play next` or `Add to queue` while the host lets people
  add; it plays next for everyone. With adding off it is refused with `The host turned off adding
  songs in this Jam`.
- `jam-reorder` moves a queued song in the queue panel (drag, or the handle's arrow keys): the
  host any song, a guest their own.
- `jam-gapless` moves every page on to the next song at once, without a gap, at the session's
  song end.
- `jam-control` refuses a guest's pause or skip, without the host's switch, with `The host
  controls playback in this Jam`, and keeps their player on the clock.
- `jam-hidden` shows a song a person may not play, such as an explicit one to the kid, as
  `Hidden song`.
- `jam-leave` leaves (`Leave Jam`) or ends (`End Jam`) from the Jam panel; the person's own music
  is back where they left it.
- `jam-connect` keeps Connect off a page in a Jam: "Play on" lists only `This browser` and the
  `Jam` button, and a Connect pause or load of the page changes nothing.

## How to get to it (user POV)

- The queue panel's, Now Playing's, and "Play on"'s `Start a Jam` button (`Jam` while in one).
- The Jam band above the main column, while in a Jam or waiting for one: `Manage` (host), `Open`,
  or `Back to your music`.
- A Jam link: `/music/jam#<link>` in the browser; `music://jam/<link>` in the iOS app, or Settings,
  `Join a Jam`, to paste one.
- iOS: Now Playing's `Start a Jam` (`Your Jam`) button, beside the scrubber's row.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, with `ok    /music is the music client`.
- Each person is a music page of their own: `$S browser sign-in --app music --page aiko-music
  --username aiko`, and the same for `mateo` and `kids`.

- **Start.** As Lucía open an album, play its first song (double-click its row), open the queue
  (`click --role button --name Queue --exact`), and click `--role button --name "Start a Jam"`
  in `--in complementary=Queue`, then the panel's `Start a Jam`. The panel turns to `Your Jam`;
  read the link with `attr --testid jam-link --attr value`, and press `Escape`.
- **Join.** `$S browser open "/jam#<link>" --page aiko-music`, then `wait-audio --page aiko-music
  --advance 5`. The band reads `lucia's Jam`; Lucía's panel lists `aiko`.
- **In step.** Read both pages' playing `audio` element (`currentTime`) and wall clocks with `eval
  --js`; carried to one instant they stay within 250 ms.
- **Add.** In Lucía's panel switch on `People can add songs`; as Aiko open a song's `More actions
  for <title>`, `Play next`. Every queue panel shows it first, `Added by aiko`, and it plays next.
- **Reorder.** In Lucía's queue focus a song's `Move <title>` handle and press `ArrowUp`: every
  member's queue shows the new order.
- **Gapless.** Note each page's `advanced`-time with an `eval --js` listener on the audio
  elements' `timeupdate`: every page changes song within 250 ms of the others, with no pause.
- **Approval and locked.** In Lucía's panel pick `You approve`, open the link as Mateo: his band
  reads `Waiting to join lucia's Jam` until Lucía clicks `Let in` under `Waiting to join`. Pick
  `Locked` and a new joiner sees `This Jam is locked`.
- **Hidden.** As Lucía queue an explicit song while `kids` is in the Jam: the kid's queue shows
  `Hidden song`.
- **Connect.** As Aiko in the Jam press `d`: the list shows `This browser` and `Jam` only. Read her
  page's device from `$S cli --as aiko -- auth targets list`, then send `auth targets control
  --device-id <id> --playing false`: the page plays on in step (`wait-audio --advance 2`).

## Gotchas

- A person holds one place per domain: joining another music Jam leaves the current one.
- The Jam panel is modal: close it (`Escape`) before driving the player bar behind it.
- A full page load (`open`) stops the page's audio; navigate in the app (`click --role link`)
  while it plays, and open a link only to join.
- Without the host's switch a guest's play, pause, and skip are refused, but their own browser's
  autoplay block still takes a tap: a page that shows `Tap play to start here` starts on `Play`.
- A Jam's queue has no shuffle, repeat, or autoplay: it stops at the end of its last song.
