# 0018. Put remote control and casting in the core and keep third-party support small

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with Connect as built, 2026-11-07 with the
  phase 3 review fixes, and 2026-11-15 with items, loading and moving playback, group-session
  membership, and the two rules D60 keeps.
- Decisions: D35, D44, D60

## Context

Music has Connect-style remote state, so one user's devices can see and control each other's
playback. Movies casts to Chromecast with Google's Default Media Receiver, plays to AirPlay from Safari,
and has a Jellyfin and Plex importer (`docs/decisions.md`, "Casting and system controls" and
"Migration from Jellyfin and Plex").
Self-hosted media servers often add compatibility layers for other clients, such as the Subsonic
API for music or the Jellyfin API for video.

## Decision

- **Connect is core.** Remote control in the style of Spotify Connect, plus loose sync of about a
  quarter second, live in the core for both domains.
- **Casting.** Chromecast and AirPlay are Connect targets, driven from a phone or a browser.
  - Cast starts with Google's default receiver.
  - The server transcodes to formats Cast can play.
- **Tight same-room sync** is in the backlog.
- **Who may control a device.**
  - A user's own devices, always.
  - A shared device, by any household user that device lists.
  - Another person's personal device, never.
  - A guest, only inside their session and only if the host allows it.
- **Third-party support now** is Chromecast and AirPlay.
  - No Subsonic API and no Jellyfin API compatibility.
  - Movies' existing Jellyfin and Plex importer stays.
  - Everything else goes to the backlog.

## Consequences

- Connect state keys on the device registry (ADR 0006), so a phone can control a TV only when the
  TV is the same user's device or a shared device that lists the phone's user.
- A Cast session plays through the same tickets as any other stream (ADR 0011).
- Third-party music apps cannot connect through a Subsonic API. The products' own clients and the
  CLI are the way in.
- Loose sync keeps devices about a quarter second apart. Playing in step in one room waits for
  tight sync in the backlog.

## Alternatives rejected

- Subsonic and Jellyfin API compatibility. Neither is built. Other integrations wait in the
  backlog.
- A custom Cast receiver at the start. Cast starts with Google's default receiver.
- Tight same-room sync in v1. It is in the backlog.

## Edge cases settled

- A user can never control another person's personal device, even in the same household.
- A guest controls playback only inside their own session, and only when the host allows it.
- A shared device is controllable by every household user it lists.
- Music importers from Jellyfin, Plex, or Navidrome are not built now. They are backlog proposals
  (ADR 0022).

## Connect as built (amended 2026-11-04)

Connect is in `packages/platform/convex/core/connect/`. The rule is `decideDevice` and the
`control` row of `deviceRules` in `convex/core/permissions/policy.ts`. Clients arrive in phase 6,
so this build is the state, the commands, and the rule.

### Commands

| Command                         | Who calls it                  | What it does                                                         |
| ------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `core.connect.player.report`    | the playing device            | Records what the device plays, where, and the request it applied     |
| `core.connect.player.requested` | the playing device            | Shows the request it has not applied yet, or null                    |
| `core.connect.targets.list`     | a controller, such as a phone | Lists the online devices the caller can control, newest report first |
| `core.connect.targets.control`  | a controller                  | Asks a device to play, pause, seek, or seek and play                 |
| `core.connect.targets.load`     | a controller                  | Asks a device to play an item from a position                        |
| `core.connect.targets.move`     | a controller                  | Stops one device and plays what it played on another                 |

The CLI has them as `media auth player report`, `media auth player requested`,
`media auth targets list`, `media auth targets control --device-id <id> --playing false`,
`media auth targets load`, and `media auth targets move`.

### State

Connect keeps two rows per device. Each row has one writer.

- `connectPlayers` is what the device last reported: the session that reported, the output, the
  playback (`item`, `playing`, `positionMs`, and the group session it follows, if any) or null
  when it plays nothing, `settled` (the revision up to which requests are done for that session),
  and the server time of the report. The item is the typed item reference group sessions use
  (ADR 0017): a movies title, episode, or file, or a music track or album.
  Only `report` writes it. The session names the device, so no call names a device it is not on. A session on no device, such as an
  API key, has no player.
- `connectRequests` is the playback controllers last asked for: the session it was made for, a
  revision, and an ask. The `targets` commands write it: `control` and `load` the device's row,
  and `move` both devices' rows in one transaction.
- Neither lives on `devices`, because `liveSession` reads the device row on every authenticated
  call. A report on the device row would run every query of every session on that device again.

A request is a desired state, not an event. Its ask is one of three:

- `transport`: play or pause `item`, with `positionMs` held at server time `at`. It holds only
  while the device still plays that item, so a pause sent for one song never lands on the next.
- `load`: play `item` from a position, whatever the device plays or whether it plays.
- `stop`: play nothing. It is the source's half of moving playback.

`control` reads what the device plays now, applies the change at the current server time, and
stores the result with the next revision. It asks a `transport` of the item the device plays, or,
while a load the device has not applied stands in, the same load with the changed transport, so a
pause sent right after loading an album still lands once the device starts the album's first song. The device
moves to the newest request it has not applied: it seeks when it is more than about a quarter
second off, plays or pauses, then reports with `applied` set to that revision. Asking twice gives
the same state, and a device that misses a request in between still ends where the last one says.

What controllers see is merged when they read it. A request stands in for the report while its
revision is above the device's `settled` and it was made for the session that reports now: a
`stop` shows nothing playing, a `load` shows its item, and a `transport` stands in only while the
report still names its item. Otherwise the report stands. A late report with an older revision
does not undo a pause.

### Rules for reports and requests

- A request is for the playback of the session that was reporting when it was made. When another
  tile opens on a shared TV, or someone else signs in on the app, the new session reports and none
  of the earlier requests apply to it.
- A report from a session other than the last reporter sets `settled` to the newest request's
  revision, whatever revision its `applied` claims. So a change of reporter settles every request
  made before it, including for a session that reports again later. Two people signed in on one
  personal laptop can take turns: the first applies a pause, the second reports, the first app
  restarts and reports `applied: 0`, and the pause does not come back. A request the first session
  had not applied when the second one reported is settled too, because the second session's
  playback replaced the one it was for.
- `settled` never goes down for the same reporting session while it stays online. An app that
  restarts and reports `applied: 0` keeps the requests it applied, and `requested` stays null. A
  session that was silent for 30 seconds reports as a new reporter does, so a request it missed
  while offline never fires when it comes back. A report that claims a
  revision above the newest request fails `invalid_args`.
- A device applies a `transport` only while it plays that ask's item. A device that changes what
  plays on its own, or stops playing, reports `applied` as the newest revision `requested` showed
  it, whether or not it acted on it, and a device that finds a `transport` for an item it no
  longer plays reports it applied the same way. Controllers already see such a request as moot,
  because its item no longer matches the report.
- `control`, `load`, and `move` refuse a device whose reporting session ended or that has not
  reported for 30 seconds (`conflict`, "That device is offline"). `control`, and `move` from a
  source, also refuse a device that plays nothing (`conflict`). So no request waits for a device to
  come back and then fires late. `load` takes an idle device.
- `list` reads only devices the caller might control: those they have a session on, every shared
  device while shared devices list them, and for a guest from a share link every device that
  follows the group session they are in, at most 64 of each, per domain for the last. It walks the caller's
  sessions one device at a time, reading that device's newest session and the device, and counts
  a device only while that session is live; a device's newest session ends last. So ended
  sessions, piled on one device or spread over many, never crowd out a live device, unless more
  than 192 of the caller's devices have only ended sessions.
  It shows the ones whose reporting session is live and that reported in the 30 seconds before it
  ran. A subscribed query runs again when a device it read reports, not as time passes, so a
  client also treats a target silent for 30 seconds as offline by its `reportedAt`.
- Reading the clock in `list` adds nothing a subscription could miss. Every authenticated query
  reads it already to check that the caller's session is live, and a target outside the window is
  one whose next report reruns the query, so the window can keep a silent target listed until the
  client's own check hides it, and never hides a live one.
- Removing a device deletes both rows in the same transaction (`dropConnect`). Changing its mode
  keeps them, so request revisions on a device never start again at 1. The sessions on the device
  end with either write. A command in flight fails `not_found`, or `conflict` because its reporter
  ended, and the device's next report fails `unauthenticated`. The app signs in again as a new
  session, so its first report settles the requests made before the change, and an `applied` it
  kept from before the change stays at or below the newest revision.
- Devices report on every change and at least every 10 seconds while the app is open. A report
  is anchored at the server time it arrives. Reports from one client must arrive in the order sent.
  The websocket client sends them in order. Two concurrent reports over HTTP can store the older
  one, until the next report replaces it.

### What each write wakes

- A report rewrites one `connectPlayers` row. It runs again the `list` of each controller who can
  reach that device, and the device's own `requested`. It runs nothing that reads `devices` or
  sessions.
- A command rewrites one `connectRequests` row, or two for `move`. It runs again the same `list`
  queries and each device's `requested`, which is how the device hears of it.

### Who controls a device

`can(principal, "control", device)` reads three facts that `deviceFor` in
`connect/facts.ts` loads:

- the relation: on a personal device, whether the principal has a live session there; on a
  shared device, whether it lists them,
- the domain the device plays, or null,
- the group session the device plays, as the principal stands in it: whether it is live, the
  principal's place in it (outside, removed, waiting, guest, or host), and its settings. A device
  plays a session while its report names one, the person whose session reports for the device is
  still in it, and no load or stop it has yet to apply has replaced what the report says it plays.
  So a tile that left the session, or a TV someone loaded something else onto, opens nothing to the
  session's guests. Only a guest's decision reads this fact, so `deviceFor` loads it only for a
  guest. `report` takes a session only from a person in it (`view` in `can`, ended included, so a
  device that has not yet seen the session end keeps reporting), and of the item's domain;
  otherwise it fails `not_found`, waiting and removed people included.

| Principal                 | Reaches the device when                                                                              | Refused as                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A person in the household | the device is their personal device, or a shared device that lists them, whatever session it plays   | `hidden` (`not-signed-in-here`, `unlisted`)                                       |
| A guest                   | the device plays a live session they are in, and that session's own `control` rule allows them (D35) | `hidden` (`guest`), or `forbidden` (`no-control`) when the host does not allow it |
| A service                 | never                                                                                                | `hidden` (`service`)                                                              |

For a guest, the device rule calls the group session's `control` rule itself (ADR 0017), so the
host always may, and a guest may only while the host lets guests control playback. A guest of
another session, one still waiting to be let in, and one the host removed find no device.

### The two rules D60 keeps

The owner kept both of today's rules (D60, 2026-11-09):

- **A personal device marked shared is controllable by the people it lists.** An admin can mark a
  device someone enrolled as personal shared. From then on it is a shared device, and every
  household person shared devices list controls it, as for any shared device. Its old owner
  controls it only while listed.
- **A household person listed on a shared device may pause it during a group session without the
  control switch.** The household rule decides for household people, whatever the session
  allows: a listed person who joined the session as a guest without control still pauses, plays,
  and seeks the shared TV that plays it through Connect. The control switch governs the
  session's shared clock (`core.together.control`) and Connect for guests from share links, not
  Connect for the household.

Then the credential needs `play` in the domain the device plays, or in any domain while it plays
nothing. A `music:play` API key cannot pause a movie. A kid's restrictions do not change control.
On a personal device with several people signed in, each of them controls it, whoever's session
reports, since ADR 0006 counts a personal device as one's own while one is signed in on it.

`can(principal, "report", device)` uses the same reach and scope for the session that reports, so a
device cannot claim to play a domain its session cannot play, and a controller's scope check reads
a domain the device could stream. A guest's session is on no device, so a guest never reports.
A refusal that is `hidden` fails `not_found`, so another person's personal device reads the same
as a device that does not exist. `list` shows only the devices `control` would allow, and shows
the item each plays as null to a controller who may not play it, as a group session's queue does,
so a listed kid sees that the TV plays something but not the explicit song.

### Loading and moving playback

Both port old music: `playback.play` with a `deviceId` started a queue on a chosen device, and
`playback.transfer` made another device the active one at the live position. The core has no
active device per person, so loading names its device and moving names both.

- **Load** (`core.connect.targets.load`) asks a device to play an item from a position, 0 when
  none is given, playing. The caller needs `control` on the device for what it plays now and
  `load` for the item's domain. `load` is `control` without guests: replacing what plays is not
  control inside a session, so a guest from a share link is refused `forbidden` (`guest`).
- **Move** (`core.connect.targets.move`) stops the source and loads what it plays on the target,
  playing or paused as it was, at `positionAt` the source's playback at the server time of the
  move. The caller needs `control` on the source and what `load` needs on the target. Moving a
  device onto itself fails `invalid_args`, where old music's transfer to the active device
  changed nothing; a client knows which device plays.
- **Play checks.** The item must be one the caller may play, and one the target's current
  principal may play: the person whose session reports for the device, with that session's
  scopes and their restrictions, such as a kid's tile on a shared TV with the explicit filter on.
  A load of an item the caller may not play fails `not_found` ("No such item"), as everywhere
  else; a move of one fails `forbidden`, since the caller saw it play. An item the target's
  person may not play fails `forbidden` ("The person on that device cannot play that"). The
  request is made for that session, so when the tile changes before the device applies it, the
  next person never gets it.
- **One step, fenced.** `move` writes the source's `stop` and the target's `load` in one
  mutation, each under its device's next revision, so a concurrent `control` or `move` sees both
  or neither. The source's `stop` is the fence. Until the source reports that revision applied,
  controllers see it play nothing, whatever a late report from it says; `control` and `move` on it
  fail `conflict` because nothing plays there; and the next `requested` it reads is the stop. So
  a late command or report from the old device cannot resume it.
- **Removing the target mid-load.** A load and a removal of its device conflict in one
  transaction. Removed first, the load fails `not_found`; loaded first, the removal deletes the
  request with the device (`dropConnect`). Either way no row stays behind.
- **A report's item is the device's word.** `report` checks the domain's play scope, as before,
  and does not check the item. Rights on the item are checked where they matter: when it is loaded
  or moved onto a device, and when a controller is shown it.
- A move carries the item, not a group session. A target whose client follows the session
  reports it again itself.

A Cast or AirPlay receiver is the output of the device that drives it: `{ kind: "cast",
receiver }` or `{ kind: "airplay", receiver }`. The name is display text the sender reads off
the receiver, so it never refuses a report. Every controller sees it, so it follows the rule guest
names follow (ADR 0007): NFKC form, trimmed, cut to 64 code points, and null when it is blank, as
Safari leaves some AirPlay receivers, or when it holds a control or bidirectional character or no
visible one. The receiver cannot sign in or run our code, so it is not a device. It shows in `list`
under the driving device's name and is controlled under that device's rule. The driving device
applies requests through the Cast or AirPlay sender, as it applies them to its own player.

### Delay

`test/core/connect/perf.test.ts` sends 100 pause and play commands from a phone to a shared TV,
both on websocket clients, after 5 warm-up commands. It times each on one clock and prints p50,
p95, and the maximum as its lane line. In five runs on an idle dev stack, p95 from sending a
command to the TV's subscription seeing it was 21 to 30 ms. P95 from sending it to the TV's report
of it committing was 40 to 61 ms. That round trip is two mutation commits and one subscription
push on loopback, so a home network adds its own round trip on top.

The rule is 250 ms at p95 on an idle stack, which the lane line shows. The test asserts a budget
with headroom instead, because it runs in CI on shared runners that stall. In 32 CI runs of the
`backend against a local Convex` job before this change, the round trip's p50 was 24 to 52 ms and
its p95 was 29 to 417 ms, with stalls of up to 483 ms in a single command. So the test holds the
median under 250 ms, which a stall of a few commands cannot move, and p95 under 1,000 ms, 2.4
times the worst CI run. A real slowdown of every command still fails the median, and a command
that never arrives still fails the p95.

### Not built yet

- Remote volume. The device's volume is a per-device setting (ADR 0019), and Connect does not keep
  a second copy.
- The clients. The music web client and the music iOS app add the device list, reporting,
  applying requests, loading, and moving (phase 6). Movies remote control is in the backlog
  (D63).

### Edge cases settled in the build

- A command to a device removed in the middle of it fails `not_found`, and its rows go with the
  device.
- A pause sent to a TV whose tile changed before it applied the pause does not pause the next
  person's playback.
- A pause a session applied stays applied after another session reports on the same device and
  the first app restarts.
- A device that went offline before it got a pause does not pause when it reports again from the
  same session.
- An app that signs in again after an admin changed its device's mode has its reports taken, even
  with the `applied` it kept, and gets the next request under a higher revision.
- An admin does not control a shared device that does not list them, and does not reach another
  person's personal device.

Added with items, loading, and moving (2026-11-15):

- A pause sent for one song does not pause the next one once the device reports it.
- An album loaded onto another device starts there at the given position, and the device reports
  the album's first song.
- A move stops the source and starts the target at the source's position, well inside the
  one-second rule.
- A late report from the source, a late `control` of it, and a second `move` from it after a move
  all leave it stopped.
- A load onto a kid's tile of an explicit song, or of a movie above the kid's age, fails
  `forbidden`, and a move onto it of one does too, before either device's request changes.
- A load onto another person's personal device fails `not_found`, and a load onto a device removed
  in the middle of it fails `not_found` and leaves no row.
- A guest from a share link controls a TV that plays their session only while the host allows
  it, finds no device once the TV stops following the session or someone loads something else onto
  it, cannot load onto it, and a guest of another session finds no device.
- A listed person who joined a session without control pauses the shared TV that plays it, and
  pauses a personal device marked shared (D60).
- A report that names a session its person is not in, or one of another domain, fails
  `not_found`.

Rejected in this build:

- A per-person active device, as old music kept. A shared TV plays one person at a time and a
  person can play on two devices, so the core keeps a desired state per device, and moving writes
  both devices' rows.
- A separate generation counter for moves. The request revision already orders every ask on a
  device and settles with the report, so the stop under the source's next revision fences it.
- Checking the reported item on every report. It would add reads to the hot path, and the checks
  that keep an item from playing where it should not run on load, move, and listing.
- Letting a guest load or move. Replacing what a TV plays leaves the session, which no host
  setting allows today.
- An append-only log of commands with a fold on read. The device would replay commands in order,
  the core would trim the log, and a retried command would need a key to stay single. A desired
  state is the same after a retry.
- A Cast receiver as its own target or registry device. It holds no session and would outlive the
  cast.
- Stored online flags, or a scheduled job that marks a device offline. The report time already
  says it.
- Listing offline devices. `control` refuses them, so `list` shows only what a command can reach.
- A device generation on Connect rows. Deleting them in the transaction that changes the device
  is two point reads.
- `settled` kept per session, in a map on the player row or a row per session. Only the session
  a request was made for can apply it, and a change of reporter already ends that playback, so the
  newest revision at the change says everything a per-session count would.
- Deleting the request when the reporter changes, or when the device changes mode. The next
  request would reuse revision 1, so an app that remembers applying revision 1 would take the new
  request for one it already applied, and an app still holding a higher `applied` would have its
  reports refused.
