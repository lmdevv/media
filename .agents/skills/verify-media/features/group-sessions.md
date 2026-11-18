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
  player (`hover --testid player-video`), click `--role button --name "Watch together"`, read
  the link with `text --label "Session link"`, then click `--role button --name "Start
  session"`. The header shows `Live · 1 watching` and the `Watching together` panel.
- **Join.** `$S browser open "/together#<link>" --page aiko`, then `wait-video --page aiko
  --advance 5`. Lucía's panel lists `aiko`.
- **In step.** Read both pages' `video` position with `eval --js` and their wall clocks
  (`performance.timeOrigin + performance.now()`); carried to one instant they stay within 250 ms.
- **Approval and locked.** In Lucía's panel pick `Ask me first`, open the link as Mateo: he sees
  `Waiting for lucia` until Lucía clicks `Let in`. Pick `No one new` and a new joiner sees `This
  session is locked`.
- **No control.** As Aiko press `ArrowRight` and `Space` on the player: a toast says `Only lucia
  can pause or seek`, and her video keeps playing on the clock.
- **Next episode.** Start a session on `Caminandes` episode 1, seek near its end, and join as
  Aiko: both pages show the `Next episode` card and move to episode 2 together (`url`).
- **Host away.** `close-page --page main` for 40 seconds: Aiko sees `lucia left the session`
  and a paused video. Sign Lucía in again, open `/together`, and press Play.
- **Kid.** As Lucía queue `Sintel` (PG-13) with `Add to Up next` while `kids` is in a session on
  `Big Buck Bunny`: the kid's `Up next` shows `Hidden`.

## Gotchas

- A person holds one place per domain: joining another movies session leaves the current one.
- Browsers block autoplay without a click; a joiner whose player waits shows `Join`.
- The host's player pauses the session when it stalls for a second and plays it on once it
  recovers; a guest's stall only makes that guest catch up.
- Each member's progress is their own, so watching in a session changes Continue watching for
  everyone in it.
