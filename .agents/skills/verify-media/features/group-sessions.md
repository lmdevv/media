# Group sessions

People watch a movie or show together in step (ADR 0017). The host starts a session from the
player and shares its link; others open it and follow the session's clock with their own stream.
The host decides who may join (anyone with the link, approval, or no one new) and whether guests
may pause and seek or add to Up next.

## Sub-features

- `session-start` starts a session from the player's `Watch together` button, with the link to
  copy before `Start session`.
- `session-join` opens `/movies/together#<link>` (the iOS app: `movies://together/<link>`) and
  plays in step with the host.
- `session-approval` holds a person on `Waiting for <host>` until the host's `Let in`.
- `session-locked` refuses a link with `This session is locked`.
- `session-control` gives a member without control the lock line `Only <host> can pause or
  seek`, refuses their seek and pause, and keeps their player on the clock.
- `session-next` counts every member down to the next episode in the credits and moves them on
  together.
- `session-host-away` pauses the session 30 seconds after the host's last tab closes, shows
  `<host> left the session` to guests, and plays on once the host returns and plays.
- `session-queue` adds a title to `Up next` from its page; an entry a person may not watch shows
  as `Hidden` to them.
- `session-leave` leaves (`Leave session`) or ends (`End session`) from the panel or the command
  menu.

## How to get to it (user POV)

- The player's `Watch together` button (the people icon), or `Watch together` in the command
  menu. In a session the button opens and closes the `Watching together` panel.
- A session link: `/movies/together#<link>` in the browser, `movies://together/<link>` on iOS.
- The command menu anywhere in the app: `Return to session`, `Leave session` or `End session`,
  and `Join session` for a pasted link.
- A title's page: `Add to Up next`, while in a session that lets the person add.
- iOS: the player's More menu, `Watch Together` or `Group Session`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the seed.
- Each person is a page of their own: `$S browser sign-in --page aiko --username aiko`, and the
  same for `mateo` and `kids`.

- **Start.** As Lucía open `Sintel` with `$S browser open /title/<id>`, play it, hover the
  player (`hover --testid player-video`), click `--role button --name "Watch together"`, wait for
  the link with `wait --text "/movies/together#"`, read it with `text --label "Session link"`,
  then click `--role button --name "Start session"`. The header shows `Live · 1 watching` and the
  `Watching together` panel, whose `Members` list reads `lucia You · Host`.
- **Join.** `$S browser open "/together#<link>" --page aiko`, then `wait-video --page aiko
  --advance 5`. Lucía's `Members` list gains `aiko`, and the header reads `Live · 2 watching`.
- **In step.** Read both pages' `video` position with `eval --js` and their wall clocks
  (`performance.timeOrigin + performance.now()`); carried to one instant they stay within 250 ms
  once the joiner has caught up.
- **Approval and locked.** In Lucía's panel click `--role radio --name "Ask me first"`, open the
  link as Mateo: he sees the heading `Waiting for lucia` until Lucía clicks `Let in` under
  `Waiting to join`. Click `--role radio --name "No one new"` and a new joiner sees the heading
  `This session is locked`.
- **No control.** As Aiko press `ArrowRight` and `Space` on the player: a toast says `Only lucia
  can pause or seek`, the same line stands in place of her `Pause` button, and her video keeps
  playing on the clock. Lucía's `--role switch --name "Pause and seek"` gives guests the button,
  and a guest's `Pause` then pauses the host's video too.
- **Next episode.** Start a session on `Caminandes` episode 1 (90 seconds long), join as Aiko, and
  as Lucía press `ArrowRight` until `video` reads about 79 seconds: both pages show the region
  `Next episode` with `S1:E2`, `Gran Dillama`, and a `Starts in` timer, and move to episode 2
  together (`url` carries the same `episodeId` on both).
- **Host away.** `close-page --page main` for 40 seconds: Aiko sees the heading `lucia left the
  session`, the buttons `Keep watching on my own` and `Leave session`, and a paused video. Sign
  Lucía in again (`$S browser sign-in`), open `/together`, which goes back to the player, and
  click `Play`: Aiko's video plays on.
- **Kid.** Start a session on `Big Buck Bunny` and join as `kids`. As Lucía open Sintel's page
  (PG-13) and click `--role button --name "Add to Up next" --in main`: the kid's panel lists
  `Hidden Added by lucia` under `Up next`.
- **iOS.** With the movies app up (`$S ios up`) as Lucía, start the session as another person on
  the web, such as Aiko, and run `$S ios open /together/<link>` with the part of the link after
  `#`. The app opens the player in landscape; the host's `Members` list gains `lucia`, the header
  reads `Live · 2 watching`, and with the controls up (`$S ios tap -x 400 -y 200`) the app's
  `Playback position` reads within a second of the host's `video`.
- **Leave and end.** A guest's panel has `Leave session`, which leaves them on the player alone
  and takes one off the host's count. The host's `End session`, in the panel or as the command
  menu's option, shows guests the heading `lucia ended the session`.
- **Proof.** `$S browser screenshot --path captures/verify/<run>/after/sessions/host-panel.png`
  with the panel open, and the same on a guest's page. Never capture the `Watch together` dialog
  or `Copy invite link`'s result: a session link lets anyone in.

## Gotchas

- `Session link` reads `…` for a moment after the dialog opens. Wait for the link's text before
  you read it, and read it before `Start session`, which closes the dialog.
- The panel opens by itself when a session starts or a person joins, and `Watch together` then
  closes it. Look for `region "Watching together"` before you click the button.
- A joiner starts a little behind and catches up at 1.05 times the speed for about 15 seconds.
  Measure the two pages only once both `playbackRate`s read 1.
- A person holds one place per domain: joining another movies session leaves the current one.
- Browsers block autoplay without a click; a joiner whose player waits shows `Join`.
- The host's player pauses the session when it stalls for a second and plays it on once it
  recovers; a guest's stall only makes that guest catch up.
- Each member's progress is their own, so watching in a session changes Continue watching for
  everyone in it.
