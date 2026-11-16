# 0018. Put remote control and casting in the core and keep third-party support small

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with Connect as built, 2026-11-07 with the
  phase 3 review fixes, 2026-11-15 with items, loading and moving playback, group-session
  membership, the two rules D60 keeps, the upgrade from v0.3.0's Connect rows, the music web
  client, the music iOS app, and casting to Chromecast and AirPlay as built, and 2026-11-16 with
  what a device reports right after it plays or pauses.
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
  `loadRevision` is the revision of the request that first asked for this load. A device that
  already started that load does not start it again: it only plays, pauses, or seeks what it
  plays, such as the album's first song.
- `stop`: play nothing. It is the source's half of moving playback.

`control` reads what the device plays now, applies the change at the current server time, and
stores the result with the next revision. It asks a `transport` of the item the device plays, or,
while a load the device has not applied stands in, that same load with the changed transport,
under the load's own `loadRevision`. A device that started the album before its report landed
only pauses the song it plays, as old music changed transport without reloading the queue entry,
and a device that missed the load starts it paused. A transport of the album itself would be
dropped by a device playing the album's first song, and a new load would start the album again.
The device moves to the newest request it has not applied: it seeks when it is more than about a
quarter second off, plays or pauses, then reports with `applied` set to that revision. Asking twice gives
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
  follows the group session they are in, at most 64 of each, per domain for the last. The last
  comes from `connectPlayers.by_session_reported`, from the 30 seconds before `list` ran, newest
  first, so offline reports of the session never take the place of a live device; only more than
  64 devices reporting the session within 30 seconds would. It walks the caller's
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

### Upgrading from v0.3.0

v0.3.0 shipped Connect without items, with writers in the CLI and SDK
(`media auth player report` and `media auth targets control`): a report named only the domain,
and a request was a flat transport. Convex refuses a schema push that stored documents do not
match, so items arrive in three steps, as ADR 0012's runner allows:

1. **Widen** (with items, 2026-11-15). The schema accepts both shapes. Connect reads an old report
   as playing nothing and an old request as never pending, since neither names an item, while
   still counting its revision, so the next request is above it. A new report or request replaces
   the old row. The new commands' argument validators refuse an old client's report or command, so
   an old report goes offline 30 seconds after the upgrade at most.
2. **Migrate**, in the same release: `connect.clearRowsBeforeItems` in `core/schemaMigrations.ts`, 256
   rows per batch, walks the requests and then the reports in one chain, so no two batches write
   the same report at once. Neither row can be converted, since it names no item, and both are
   transient state the device writes again on its next report, so it clears them in place, to
   what Connect already reads them as, and deletes nothing:
   - An old request becomes a `stop` under the same revision, and the device's `settled` rises to
     it, so it never fires.
   - An old report's playback becomes null, and its `settled` stays, so a load made since the
     upgrade still waits for the device.

   Deleting either row would break the revision rules above. Without the request, the device's
   revisions start again at 1, so an app that kept `applied` skips the next request or has its
   reports refused. Without the report, the device's next report settles every request before it,
   a load made since the upgrade included. The image's init, the NixOS module, and
   `scripts/dev-stack.sh` run the migration after every deploy.

3. **Tighten**, not before the first release after the one that ships this migration. That
   release drops the old shapes from `convex/core/connect/model.ts`, `reportOf`'s and
   `pendingRequest`'s shape checks, `connect/beforeItems.ts`, and the migration. Its notes tell
   v0.3.0 installs to upgrade through the release with the migration first, since a v0.3.0
   install that skips it fails the schema push and stays on the old functions.

`test/core/connect/upgrade.test.ts` imports rows in v0.3.0's shapes, checks how Connect reads them,
runs the migration across more than one batch of each table, and checks that a load made in
between still waits and that Connect works afterwards.

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
- Movies remote control, in the web client and the movies iOS app, is in the backlog (D63).

### The music web client (amended 2026-11-15)

The music web client at `/music` brings back old music's device picker and remote control on
Connect. The device side is in `packages/player`, beside the controller whose rules it goes
through, so the music iOS app can use it too: `connect-player.ts` reports and applies requests,
`connect-devices.ts` reads the device list, `tab-lead.ts` picks the tab that speaks for the
browser, and `use-connect.ts` runs them in the player provider.

- **Reports.** The browser reports the song loaded in its player, whether it plays, and where, on
  every change of song, play state, engine state, seek, or applied revision, and every 10
  seconds. It does not report as the song plays on. Old music reported every 15 seconds while it
  played and sent a heartbeat every 30; 10 seconds keeps two reports inside Connect's 30-second
  online window. A browser with no song loaded reports playing nothing.
- **Applying requests.** One rule decides every request and every step of a load's start; the
  next section has its table. A `transport` seeks only when it is more than 250 ms off. A `load`
  of the song the shared queue plays now plays that entry from the position and keeps the queue,
  which is how a move lands. A `load` of another song or of an album replaces the queue, as old
  music's play on a chosen device did. A `stop` lets go of the song and keeps the browser's place
  in it. The browser reports every request applied, moot ones included.
- **One active device.** The core keeps no active device, so the client works out old music's from
  the list: one of the listener's other devices that plays music, else one that holds a song
  paused, while nothing is loaded in this browser. While there is one, the player bar, the mini
  player, Now Playing, and the keyboard follow and control it, as old music's remote control did:
  play, pause, and seek send `control`; skips move the shared queue, which that device follows,
  paused ones included. Playing a list in this browser takes playback back and pauses that device,
  and a browser that holds a song paused lets it go once another of the listener's devices plays,
  as a newly active device stopped the old one. Volume stays with the device that plays, so the bar
  hides it while another device plays.
- **The list.** It shows the listener's own personal devices that reported in the last 30 seconds,
  by name. Shared devices stay out, as old music's list never had them (D62). A device that goes
  quiet leaves the list within 5 seconds of its last report turning 30 seconds old.
- **Moving and loading.** A device row in "Play on" moves playback there with `move`, from this
  browser or the device the player follows; with nothing playing anywhere it loads the current
  song there. "This browser" moves it here. An album's menu has "Play on", which loads the album
  onto another device and takes playback over. It replaces old music's command menu form for
  `playback.play` with a device, which the `/music` port did not keep.
- **One tab per browser.** Every tab on the origin shares the browser's device (ADR 0020), so
  only one tab reports and applies requests: the first to take a Web Lock, or a tab that starts
  playing, which takes the lock over. A tab that moves playback here takes it before the move. A
  tab whose lock another tab took stops reporting and then lets go of its song
  (`speakForDevice`), so the browser never plays audio that its device neither reports nor obeys.
  Old music let every tab play, and its shared pause stopped them all. Every tab follows the
  requests the core shows, though only the leader applies them, so a tap in a tab that does not
  lead makes moot the requests it saw, as in the tab that leads, before it takes the lead.

#### One rule for applying requests

Every request, and every step of a load's start that waits on the network or on the queue, names
the load it is for: its `loadRevision`, and once it started, the queue entry the player started
for it. Before anything applies, `ConnectPlayer` checks that load against what is current at that
moment, not when the request or the step began (`#standing` in `connect-player.ts`). A newer
revision that names an older load is still an older load, so a counter alone never decides.

The listener's actions reach the player through one boundary: `PlaybackController`'s play, pause,
skip, seek, jump, and play-a-list calls run `onListenerAction` before they change anything, and
`ConnectPlayer` makes every request seen so far moot there. The player bar, the keyboard, the
command menu, and the system media controls (Media Session: headsets, media keys, the lock
screen) all call those, so none of them can act while a Connect load still lands over it. The
system media controls' play and pause play or pause whatever plays, never toggle it. On the phone,
the app's `RemoteCommands` module delivers each of the system's commands with its outcome, decided
where it happened, and with its place in one order shared with the app's own commands, so a press
the person chose again after applies to nothing (The music iOS app, below). What Connect itself applies goes through other calls
(`steer`, `playTracksAt`, `playCurrentAt`, `release`) that never run it.
Moving playback here and playing an album on another device reach the controller through those
other calls too, so they make the requests moot themselves first.

| A request arrives                                                                                                       | What holds now                                                                                                                                             | The device                                                               | It settles                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| any request                                                                                                             | the player follows a group session (ADR 0017)                                                                                                              | changes nothing                                                          | its revision                                  |
| `transport` of a song                                                                                                   | that song is the one here                                                                                                                                  | plays, pauses, or seeks it                                               | its revision                                  |
| `transport` of a song                                                                                                   | another song, or none, is here                                                                                                                             | changes nothing                                                          | its revision                                  |
| `load` under a new `loadRevision`                                                                                       | anything                                                                                                                                                   | starts it, and drops a load still starting                               | the newest revision asked of it, once started |
| `load` of the load still starting here                                                                                  | anything                                                                                                                                                   | starts it with this ask instead                                          | this revision, once started                   |
| `load` of the load that started here                                                                                    | the entry it started still plays here                                                                                                                      | plays, pauses, or seeks it                                               | its revision                                  |
| `load` of the load that started here                                                                                    | what plays here moved on, as after a skip here                                                                                                             | changes nothing                                                          | its revision                                  |
| `load` of an older load, or of one dropped                                                                              | anything                                                                                                                                                   | changes nothing                                                          | its revision                                  |
| `stop`                                                                                                                  | anything                                                                                                                                                   | lets go of the song, and drops a load still starting                     | its revision                                  |
| the listener plays, pauses, seeks, skips, or plays a list here, from any screen, shortcut, or the system media controls | anything                                                                                                                                                   | drops a load still starting                                              | every revision seen                           |
| the player starts or stops following a group session (ADR 0017)                                                         | anything                                                                                                                                                   | drops a load still starting                                              | every revision seen                           |
| the phone's `RemoteCommands` module delivers a play, pause, unplug, next, or previous                                   | the person made a new choice after the press, here or through Connect: played or paused against what plays here, picked a song, or let go of playback here | changes nothing: the person chose again after it                         | nothing                                       |
| the phone's `RemoteCommands` module delivers a play it decided for the player on the lock screen                        | nobody chose again after the press, and that player holds the song here, a ticket still out too                                                            | plays, drops a load still starting, and keeps the choice                 | every revision seen                           |
| the phone's `RemoteCommands` module delivers a play it decided for the player on the lock screen                        | the engine moved on from that player, as to the next song                                                                                                  | changes nothing: nobody chose to play what plays now                     | nothing                                       |
| the phone's `RemoteCommands` module delivers a pause it decided for the player on the lock screen                       | nobody chose again after the press, whether that player holds the song here or the engine moved on from it, as at the song's end                           | pauses what plays now, drops a load still starting, and keeps the choice | every revision seen                           |
| headphones unplugged                                                                                                    | nobody chose again after the unplug, and a song here is meant to play, its sound started or not                                                            | pauses it, drops a load still starting, and keeps the choice             | every revision seen                           |
| headphones unplugged                                                                                                    | nothing here is meant to play                                                                                                                              | changes nothing                                                          | nothing                                       |
| the phone's `RemoteCommands` module delivers a scrub of the player on the lock screen                                   | that player holds the song here, whatever the person chose since                                                                                           | seeks there, as expo-audio moved it, and drops a load still starting     | every revision seen                           |
| the phone's `RemoteCommands` module delivers a scrub of the player on the lock screen                                   | the engine moved on from that player, as to another song                                                                                                   | changes nothing                                                          | nothing                                       |
| the phone's native player reports a song finished, before or after its own pause at the end                             | anything                                                                                                                                                   | moves on, as nobody's action: a load still starts                        | nothing                                       |
| none: the core shows nothing left to apply                                                                              | a load still starts here                                                                                                                                   | drops it, as the core settled it                                         | nothing; the core settled it                  |

| A step of a load's start answers                                                             | What holds now                                    | The device                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the album's songs                                                                            | the load still starts here                        | writes the queue, as the load's newest ask says                                                                                                                                                                            |
| the album's songs failed                                                                     | the load still starts here                        | drops it, and settles its newest ask as tried                                                                                                                                                                              |
| the album's songs, or their failure                                                          | a newer request or the listener replaced the load | changes nothing; whoever replaced it settles                                                                                                                                                                               |
| the new queue's write                                                                        | the load still starts here                        | starts the queue's entry as the load's newest ask says now, holds the load started on it, and settles; an entry the new queue loaded before the write answered moves to the asked position and pauses, or plays from there |
| the new queue's write                                                                        | a newer request or the listener replaced the load | changes nothing; the player follows the new queue, playing or paused as the listener last chose                                                                                                                            |
| the queue arrives holding its current entry, for a song's load waiting on it                 | the load still starts here                        | plays that entry from the position when it holds the song, keeping the queue, and otherwise replaces the queue with the song                                                                                               |
| the queue's whole listing arrives without its current entry, for a song's load waiting on it | the load still starts here                        | replaces the queue with the song, since the entry left out holds a song the listener may not play                                                                                                                          |
| the queue arrives without its current entry, and its listing is not whole                    | the load still starts here                        | keeps waiting                                                                                                                                                                                                              |

The queue's listing is whole only at the revision of the queue's state (A whole listing is whole
for one revision, below):

| The queue's state shows | The listing's pages                                                                | The listing is whole |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------- |
| revision r              | every page in, each read at r                                                      | yes                  |
| revision r              | every page in, all read at another revision, as a page's last answer kept on retry | no                   |
| revision r              | every page in, read at different revisions                                         | no                   |
| revision r              | pages loading again, with the last whole listing kept                              | no                   |

- **Waiting for the queue.** A load of a song is a move only when the queue plays that song now,
  and a browser can tell only once its queue arrived and holds the current entry. Until then the
  load waits. So a move onto a browser that just opened, or one made while a new queue's pages
  load, never replaces the shared queue with one song. A whole listing without the current entry
  ends the wait: `music.queue.list` leaves out only an entry whose song the listener may no
  longer play, as after their library access is revoked, and a load names only a song they may
  play, so the entry left out never holds it, and the load replaces the queue.
- **A whole listing is whole for one revision.** The queue's state (`music.queue.get`) and each
  page of its listing are subscriptions of their own, and either can lag: a page whose
  subscription retries keeps its last answer meanwhile, and a client can hear one query's change
  before the other's. The core keeps a revision on the queue, which moves on with every change to
  the queue or its entries, and answers it with the state and with every page. The listing is
  whole only for the revision it was read at, so a listing kept from before the queue moved on
  never says its new entry is left out. Access changes are not queue writes and leave the
  revision as it is: an entry the listener may no longer play drops out of the next listing read
  at that same revision. `queueStateOf` and `listingOf` in `packages/player/src/queue-listing.ts`
  hold the rule, and the web and phone players both read the queue through them.
- **The listener's newest choice.** A new queue starts playing or paused as the listener last
  chose, here or through Connect, when its write answers, not as when it was sent. The old queue
  ending meanwhile is no choice, so a list played then still plays. Convex can show a mutation's
  writes to subscriptions before it answers the mutation, so the new queue may arrive and load its
  first song first. The answer then applies that choice to the song loaded: it moves to the asked
  position and pauses, or plays from there. The engine always ends doing what the player means.
- **A song on its way.** Once a new queue's write answered, its first song counts as the song here
  while its ticket is on the way: the browser reports it, and a play, pause, or seek of it, sent
  from another device or tapped here, starts it as asked.
- **A load dropped when the tab stops.** A tab that stops leading drops a load still starting,
  and takes it again as a new one once it leads again while the core still shows it. A step of the
  dropped start never acts for the new one.
- **A write already sent.** A newer request makes an older load's start moot, but a queue write
  it already sent still lands on the shared queue. The browser then follows the queue, as it follows
  any change of it, playing or paused as the listener last chose.
- **No start waits without end.** A load of a song waits for the queue's whole listing at the
  revision of its state, which ends the wait whether or not it holds the current entry. An
  album's songs and a queue write wait for the network's answer. Any wait also ends when a newer request or a tap here replaces the
  load, when the tab stops leading, or when the core shows nothing left to apply. The core settles
  every request when a device reports again after 30 seconds of silence (Rules for reports and
  requests), so a load still starting then is dropped and never starts.

**What a report says right after a play or pause** (amended 2026-11-16). A report that settles a
request describes the device after it applied that request, never before. Every engine takes a
play or pause at once, as its own `samplePlayback` shows, but says so in an event that comes later:
an audio element fires `playing` or `pause` a task later, expo-audio's report reaches JavaScript
later, and a Cast receiver answers over the network. `PlaybackController` reported whether the
song plays from the status those events set, so the report `ConnectPlayer` sends as it settles a
pause still said the song played, and the next one, a moment later, said it paused. Controllers
saw the pending pause, then the device playing again with nothing pending, then paused: a person
who tapped play in between got the bar's `Pause`, and the device stayed paused (CI on #165, where
the trace's sync frames show the second `control` asking `playing: false`). A remote play flapped
the same way. Now, while a play or pause the player sent its engine (`#enginePlay`,
`#enginePause`) has yet to be answered by the engine's next play, pause, end, or failure event,
what `ConnectPlayer` reports (`reportedHere`) is the engine's own answer. A call that changed
nothing, as a play of a song that plays or one an engine with nothing loaded ignored, waits for no
event, so the report keeps reading the status. Everything else reads `playingHere`, the status the
engine's events set, as before: the bar, toggles, the lock screen, group-session followers,
history, and whether a Connect request is a new choice for the phone's order of system commands.
So a label and the tap on it always agree, and what the engine does by itself counts as a choice
only once its event arrives: a lock-screen pause expo-audio already made is not yet the app's, and
a scrub from another device that keeps playing as it last saw takes no number. A report sent while
a call is unanswered says what the engine does then, whoever changed it. Each engine's
`samplePlayback` shows a play or pause it took at once (`PlayerEngine` in `engine.ts`).

| The player last                                                                            | Its engine            | What Connect reports           | The status the bar and toggles read |
| ------------------------------------------------------------------------------------------ | --------------------- | ------------------------------ | ----------------------------------- |
| sent a play or pause that changed what it does: a Connect request, a tap, a system command | has not sent an event | what the engine does now       | as the engine's last event set it   |
| sent a play or pause that changed nothing                                                  | sends no event        | as the engine's last event set | as the engine's last event set it   |
| sent a play or pause                                                                       | sent its event        | as the event read the engine   | as the event read the engine        |
| sent nothing since the engine changed by itself, as expo-audio from a lock screen          | has not sent an event | as the engine's last event set | as the engine's last event set it   |

A tap of play or pause on a device the player follows asks for the opposite of what the bar shows
as it is tapped (`remoteActions` in `connect-actions.ts`), so it carries the label the person
tapped. The bar shows the core's merged view: the request while it is pending, then the report
that settled it, which now says what that request asked.

### The music iOS app (amended 2026-11-15)

The music iOS app brings back old music's device sheet and remote control on Connect, through the
same device side as the web client: `connect-player.ts` reports and applies requests,
`use-connect.ts` runs it in the phone's player provider, and `connect-actions.ts` holds the moves,
loads, and remote controls both clients' players make.

- **One app is one device.** The app has no tabs, so it takes no Web Lock (`ConnectHost.locks` is
  undefined): it speaks for its device as soon as the core names one. It speaks only while it plays
  the person's queue on the core. A phone that plays its own queue of downloads while the server is
  away neither reports nor applies requests, and lists no devices, until it hands that queue back.
- **Reports and the background.** The phone reports on every change and every 10 seconds, as the
  browser does, never as the song plays on. iOS keeps an app that plays audio running in the
  background, so the phone keeps reporting and applies requests there, a remote pause included.
  iOS suspends an app that plays nothing in the background, and a killed app stops, so either
  leaves the list once its last report is 30 seconds old, as old music's phone left once its
  heartbeat stopped.
- **One active device.** As in the browser, the phone follows the device that plays while nothing
  plays here: Now Playing's device button reads `Playing on <device>`, the iPad's player bar lights
  its speaker button, and play, pause, seek, and skips control that device. Now Playing hides the
  volume slider meanwhile, since volume stays with the device that plays. A phone holding a song
  paused lets it go once another of the person's devices plays.
- **The device sheet.** Old music's sheet comes back from Now Playing, the iPad's player bar, and
  Settings: this phone first, then the device that plays, then the rest by name. A row moves
  playback there, and the sheet shows the move until that device answers it, failing after 10
  seconds or when the core refuses it. A move is done only once the core took it and the device
  answered with a report of its own: `targets.list` shows a load the device has not applied as its
  playback, marked `pending`, and the device the player follows counts it, so a source that stopped
  is no sign the move landed (`moveArrived` in `connect-devices.ts`, which the browser's Play on list
  reads too). Old music closed its sheet once its server named the device, without waiting for it.
  A failed move keeps the devices it went from and to, as listed when it started, so its failure
  stays once a device's last report expires and it leaves the list, as old music's sheet, which
  listed offline devices too, kept it. A move the core took but its device never answered stopped
  the device it went from, so `Stay here` moves playback back there, and `Try again` waits for the
  device again; after a refusal, `Stay here` only closes the sheet. The browser's list waits again
  too when its device is picked again. An album's actions have `Play on`, which loads the
  album onto another device and takes playback over, as the web client's album menu does. The tip
  copy of old music's sheet is gone, per the content rules, and so is its `Cancel transfer`: a move
  is one write on the core, so there is nothing to cancel.
- **The system's controls.** The lock screen, Control Center, headphones, and CarPlay reach the
  player through the app's `RemoteCommands` module: next, previous, the scrubber, play, pause, and
  the play/pause toggle, and headphones unplugged, which pauses a song meant to play and leaves one
  paused, or none, alone. Each calls the controller's handlers, which run `onListenerAction`.
  expo-audio also plays, pauses, and scrubs the AVPlayer itself for these, and pauses every player
  when headphones are unplugged, but it tells JavaScript only of the player's new state, and a song
  that stops at its end reports a pause too, sometimes before its `finished` report. So the engine
  never takes a pause for the person's or for an end: a command counts by where it comes from, at
  any place in the song, and a song ends only on the player's own `finished` report.
  - **A command carries its own outcome.** The module decides each play, pause, and toggle where it
    happens, as a play or a pause, and sends it with the id of the player on the lock screen it
    acted on, which the app names to it as expo-audio puts a player there (`follow`). A toggle is
    what expo-audio did with it: the module reads that player once the press's targets ran, which
    the command center calls in one main-queue turn, before any later state of the app's player can
    change the answer. JavaScript never works a command's outcome out from what plays by the time
    the event arrives: a toggle that paused a song as it ended stays a pause after the song's
    `finished` report moved the player on to the next one.
  - **Who a command applies to** (the rows above). A play applies only to the player it was decided
    for, while that player holds the song here (`NativeEngine.isCurrentPlayer`). Once the engine
    moved on from it, to the next song or to a stream it reopened, nobody chose to play what plays
    now, so it changes nothing. A pause decided for a player the engine moved on from still means
    the person wants playback paused, so it pauses what plays now, unless they chose again after
    it.
  - **A command applies only if nobody chose again after it.** JavaScript and Swift share no clock,
    so the module keeps one sequence of numbers. It stamps every command it forwards with the next
    one as the press comes, in the main-queue turn in which the command center also calls
    expo-audio's target, and the unplug on the thread iOS posts it on. The app takes the next
    number of the same sequence (`stamp`, a synchronous module call) as each new choice starts,
    before it reaches a player: the controller calls `NowPlayingControls.commanded` at the start of
    a play or pause tapped here, a jump, a play-a-list, and each Connect request that picks a song
    here (`playTracksAt`, `playCurrentAt`), lets go of playback here (`release`), or plays or
    pauses against what plays here (`steer`). The phone's controls (`lockScreenControls` in
    `native-host.ts`) apply a forwarded play, pause, unplug, next, or previous only while its stamp
    is newer than every choice the app took a number for, and drop the rest. Presses never order
    each other: the module sends them in the order they came, though a decided play or pause goes
    one main-queue turn after the press and the others at once, so each applies in the order it
    arrives, as before. A press the controller applies is that press: what the controller reports
    while it applies one takes no new number.

    What takes no number carries the choice before it, so a press made after that choice still
    applies: a seek, a skip, which keeps playing or paused as it was, a Connect request that leaves
    playing or paused as the phone shows it (another device that scrubs sends the playing state it
    last saw), and what the player does by itself, which is a song handing over to the next at its
    end, the controller following a queue the core moved, a natural advance with nothing
    preloaded, and reloads for an expired ticket or a media server back online. So a pause decided
    for a song as it ended still pauses the next one, and a lock-screen pause and then Next in the
    app loads the next song paused. A Connect load takes its number when it writes its queue here,
    after an album's songs arrive. A scrub is not ordered: it applies while the player it moved
    holds the song, whatever the person chose since, so the controller's position follows where
    expo-audio moved the AVPlayer; a song picked since replaced that player. The web's Media
    Session handlers run on the page's own thread, in order with its other commands, and ignore
    `commanded`.

    What stays open is the turn of the press itself: the command center calls this module's
    target and expo-audio's in no documented order, so a command the app gives on the JavaScript
    thread between the two (expo-audio plays and pauses synchronously there) can still lose to the
    press. That window is the length of one target call, far below the 2–3 ms between a song
    stopping and its handoff that main has too.

  - **A command applies as a tap does.** The controller applies a play or pause to its own choice
    and to the engine alike, exactly as a tap that chose the same, though the native player already
    did as asked: the engine hears the play even when the player plays already, so whether a song
    that ends hands over to the next without a gap, and whether an unplug finds a song meant to
    play, follow the person's last choice. A command counts even while another song's ticket is
    out, since it is the person's choice for whatever plays next.

  An interruption, such as a call, pauses and resumes the player with no command, so the controller
  hears it as the player's state only, as old music's did. A pause that reached the engine before
  the player's end report arrives holds: the next song loads paused. The controller's seek lands on
  the place expo-audio moved the AVPlayer to.

### Casting as built (amended 2026-11-15)

`p6-cast` brings back old movies' casting and makes Chromecast and AirPlay outputs of the
devices that drive them, as "Loading and moving playback" above describes.

- **Google's default receiver, and the server's profiles.** Both web clients load Google's Cast
  Web Sender SDK in Chromium browsers only, from the `www.gstatic.com` folders the content security
  policy allows, and cast to the Default Media Receiver. The receiver reports no codecs, so each
  domain asks for what every Chromecast plays (`@media/contracts/cast`): a movie negotiates
  through the ladder with `castCapabilities`, which takes 1080p H.264 and AAC over fMP4 HLS or an
  MP4 file, so an HEVC, 4K, or HDR file casts as an H.264 transcode; a song plays as its original
  when it is MP3 or AAC (`castMusicProfile`) and as the AAC 320 kbps transcode otherwise.
- **Receiver URLs.** A receiver gets a receiver credential in place of the start's ticket (ADR
  0011, "Receiver credentials"), so it plays for as long as the start's admission and stops when
  the session ends.
- **Movies, on the web.** The movies client ports old movies' casting: the cast button and its
  Play on menu (Chromecast, AirPlay in Safari, the browser's own picker elsewhere), "Playing on
  <TV>" over the frame, and the player's controls, keyboard, volume, subtitles, audio, and quality
  driving the TV. Casting hands the start to the TV (`PlaybackController.handOff`): the page lets go
  of its stream, the receiver gets a stream of its own negotiated for the Chromecast, and the
  controller's `output` follows the TV, so progress reports and a group session follow it.
  Disconnecting continues on the page where the TV was, and leaving the player stops the TV but
  keeps the device for the next title, as old movies did. Movies remote control is in the backlog
  (D63), so a movies cast does not report to Connect.
- **Movies group sessions.** Old movies let a watch room's member cast, and the room followed the
  TV, so a member of a movie group session can cast: the session's follower drives the TV as it
  drives the element, correcting drift by seeking (`fixedRate`), and the person's controls move the
  session's clock as they do without a TV (D35).
- **Music, on the web.** "Play on" gains a Chromecast row under "This browser". Connecting plays
  the queue through the TV (`PlaybackController.castTo`): the song here moves to the TV at the place
  it reached, playing or paused as it was, counted as the same play, and each song after it loads
  on the TV with its own start, ticket, and credential. The browser reports `{ kind: "cast",
  receiver }` as its output, so the person's other devices list it as "Casting to <TV>", and
  their play, pause, and seek reach the TV through the browser, which applies them to the TV as to
  its own player. While it casts, the volume control shows and sets the TV's volume, following the
  TV's own remote, and the browser keeps its own for when the cast ends. Disconnecting brings the
  song back to the browser where the TV was. The TV plays song by song, with the receiver's own
  short gap between songs, since the default receiver keeps no gapless queue of ours.
- **Music on iOS: AirPlay.** Now Playing has the system's route picker (`AVRoutePickerView`, the
  app's `AudioRoute` module). The music plays where it was until the person chooses a route, and
  then AVFoundation moves it. The phone reports `{ kind: "airplay", receiver }` while an AirPlay
  output is in the route, so the person's other devices show the receiver on its row.
- **Movies on iOS: AirPlay.** The movies app's player has had the system's AirPlay button since
  the iOS port (#144), and its `AVPlayer` allows external playback. It does not report to
  Connect, as movies remote control waits in the backlog.
- **Senders sharing a receiver.** `/movies` and `/music` share one origin, and two tabs can cast to
  one TV. The mirror names the media it describes (`RemotePlayer.mediaInfo`), and a sender treats
  only its own newest load's media as its own: the media before it, or another sender's, changes
  nothing. Once another sender's media takes the receiver from a sender's own, that sender takes
  its song or movie back paused where the TV last played it (`PlaybackController.castTaken`, the
  movies `CastPlayback`'s `onTaken`) and leaves the session without stopping it, so the other
  media plays on. A tab, in either client, joins on its own only a session it started, after a
  reload too (`TAB_AND_ORIGIN_SCOPED`), where `v0.2.0` movies joined any session of the origin
  (`ORIGIN_SCOPED`): with `/music` on the same origin, that would have a movies tab load its movie
  over a song another tab cast, and old music had no casting to keep. Picking the TV in the cast
  menu still joins its session and plays there.
- **A start that outlived its ticket.** A movie paused past its ticket's expiry casts with a new
  start (`startHandedOff`), as one whose ticket expires mid-cast does; `v0.2.0` renewed its token
  before it expired.
- **Music group sessions.** Old music had no casting and no AirPlay button, so a Jam casts nowhere
  (D62): it plays on each of the person's players that follows it (ADR 0017). In a Jam, "Play on"
  has no Chromecast row, and joining one ends the cast this tab drives, one started from Chrome's
  own Cast menu included; the player's `castTo` then takes only the end of a cast. The music app's
  Now Playing shows no AirPlay button in a Jam. iOS still offers its own AirPlay route in Control
  Center, as it did under old music.
- **Music iOS device sheet.** "Play on" says where a device that casts or AirPlays sends its
  sound in place of its status ("Casting to <TV>"), as the web's list does.

#### One rule for what a receiver says

Each Cast sender numbers its loads on the receiver, and applies what the receiver or the SDK says
only to the newest load once its media is on the receiver (`#current` in
`apps/web-music/src/casting/cast-engine.ts`, `#load` and `#loading` in
`apps/web-movies/src/casting/cast-playback.ts`). The player then applies the engine's events only
while they belong to its own load, as for any engine.

| What arrives                                     | What holds now                                                                                                               | The sender                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| a receiver credential for load n                 | n is the newest load                                                                                                         | loads the song on the receiver with it                                                            |
| a receiver credential for load n                 | a newer load, or an unload, replaced n                                                                                       | changes nothing                                                                                   |
| `loadMedia`'s answer for load n                  | n is the newest load                                                                                                         | takes the receiver's state as the song's, or fails the load                                       |
| `loadMedia`'s answer for load n                  | a newer load replaced n                                                                                                      | changes nothing                                                                                   |
| `loadMedia`'s answer for load n                  | the player let go of n, as after a move to another device or a skip, and no newer load has sent its song to the receiver yet | stops the song on the receiver                                                                    |
| a change of the receiver's mirror                | the newest load's media is not on the receiver yet                                                                           | changes nothing: it describes the media before                                                    |
| a change of the receiver's mirror                | the newest load's media is on the receiver                                                                                   | reports the position, play, pause, waiting, or end                                                |
| a change of the receiver's mirror                | the mirror names the media before the newest load, and the newest load's own has not shown                                   | changes nothing                                                                                   |
| a change of the receiver's mirror                | the mirror names other media after the newest load landed, or after its own showed                                           | takes the song back paused where the TV was, and leaves the session with that media playing       |
| a play or pause asked while a load is on its way | anything                                                                                                                     | asks it of the newest load's media once the mirror shows it, not of the media before              |
| the mirror's time jumps to 0                     | the sender asked for a seek to 0, as a restart of the song                                                                   | takes it as that seek's answer and reports the position                                           |
| the mirror's time jumps to 0 from past 1 s       | the sender asked for no seek to 0                                                                                            | changes nothing: the mirror resets so as the session ends                                         |
| the receiver goes idle, finished                 | the newest load's media is on the receiver                                                                                   | reports the song ended, and the player moves on                                                   |
| the receiver goes idle with an error             | the newest load's media is on the receiver                                                                                   | asks the media server why; a refused credential is `expired` and the player starts the song again |
| the media server's answer about a failed load n  | a newer load, or an unload, replaced n while it was asked                                                                    | changes nothing                                                                                   |
| the receiver goes idle with an error             | a newer load is on its way                                                                                                   | changes nothing                                                                                   |
| the Cast session ends                            | anything                                                                                                                     | the browser plays again, from where the TV was                                                    |

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

Added with the first review round (2026-11-15):

- A pause sent after a device started an album, before its report of that landed, comes to it as
  the same load under the same `loadRevision`, so it pauses the song it plays and does not load the
  album again.
- A guest lists a live phone that follows their session behind 64 offline reports of the session.
- v0.3.0's rows pass the schema push and read as playing and asking nothing. The migration clears
  every old report and settles every old request under its own revision, so nothing fires, a load
  made in between still waits, and the device's next request is numbered above the old one.

Added with the music web client's first fix round (2026-11-15):

- A pause here while an album sent from another device writes its queue holds: the album starts
  paused.
- A load whose album fails after a newer load started leaves the newer load to play and settle.
- A play, pause, or seek of a load the listener skipped away from here changes nothing, even under a
  newer revision.
- A move onto a browser whose queue has not arrived waits for it and keeps the queue.
- A tab another tab of the browser took over from stops playing, so a remote pause stops all the
  browser plays.
- A pause sent while an album's first song is on its way starts it paused, and so does a pause
  tapped then.
- A pause sent while an album's queue is written starts the album paused, from the position sent.
- A load that a tab dropped when it stopped leading starts once when it leads again.
- A tap in a tab that does not lead makes moot the requests it saw before it took the lead, and a
  load it made moot stays moot when it is asked again once that tab leads.

Added with the music web client's fourth fix round (2026-11-15):

- A pause or a skip from the system media controls (a headset, media keys, the lock screen) while
  an album sent from another device still loads drops that load, as a tap on the screen does.

Added with the music iOS app (2026-11-15):

- A pause from a phone's lock screen while an album sent from another device fetches its songs
  drops that load, and the phone reports the song it holds paused.
- A pause from the lock screen while that album's queue is written starts the album paused.
- A play from the lock screen while the next song's ticket is out plays that song once it loads.
- A remote pause, then a skip on the phone: the next song stays paused, and a later play or pause
  of the old song leaves it alone.
- A move onto a phone that just opened waits until its queue's whole listing names the current
  entry, then plays that entry from the source's position and keeps the queue.
- An older load's failure, and its old song's late failure from the native player, leave a newer
  load to play and settle.

Added with the music iOS app's first fix round (2026-11-15):

- A pause from the lock screen half a second before the song's end, while an album sent from
  another device fetches its songs, drops that load: the album never starts, and the phone reports
  the song it holds paused. A pause there and then Next loads the next song paused.
- The same pause holds when its command reaches the app before the player's report of it.
- A song that plays to its end, reporting its pause before it reports it finished, is nobody's
  action: an album load still starting goes on and plays.
- A headphone toggle counts as what the player did with it: a pause drops a load still starting,
  and the next toggle plays.
- Headphones unplugged keep the pause, so a song another device moves the queue to loads paused,
  and pause a song meant to play before its sound starts. Unplugged while nothing plays, they leave
  an album sent from another device to start.
- A move to a device whose request is still pending when the source stops keeps waiting, and fails
  after 10 seconds unless that device reports the song itself.
- A refused move to a device whose last report then expires keeps its failure, with Try again and
  Stay here, once the device leaves the list. After a move the core took that its device never
  answered, Stay here moves playback back, and Try again waits for the device again.

Added with the music iOS app's second fix round (2026-11-15):

- A pause on the phone, then a play from the lock screen once the player plays again: the engine
  takes the play too, so the song hands over to the next one without a gap at its end, and
  headphones unplugged later still pause it, so a song another device moves the queue to loads
  paused.
- A headphone toggle that pauses a song as it ends, its `finished` report reaching the app first
  and moving the player on to the next song: the toggle stays a pause, decided where it was
  pressed, and pauses the next song. A play decided for a song the player has moved on from
  changes nothing.
- A move the core accepts after the sheet's 10 seconds ran out: the failure keeps that the core
  took it, so Stay here moves playback back to the device the move stopped, and Try again waits for
  the device again. The browser's list shows a failure as a toast and has no Stay here, and picking
  the device again there reads whether the core lists it as playing, so it needed no change.

Added with the music iOS app's third fix round (2026-11-15):

- A pause from the lock screen, then a play tapped in the app before the module's pause reaches
  JavaScript: the song keeps playing. The same holds when the person starts another song in the app
  instead, when they pause in the app after a play from the lock screen, and when another device
  plays the song through Connect, after the phone reported it paused, before the pause arrives. A
  lock-screen Next pressed before the person started another album in the app changes nothing.
- A seek or Next in the app, or another device's scrub that keeps the song playing as it last saw
  it, between a lock-screen pause and its command: the pause applies. After Next the next song
  loads paused; after a seek, a song another device moves the queue to loads paused.
- A lock-screen pause and Next reach the app in the order they arrive, though the module stamped
  them the other way round.
- A lock-screen scrub that reaches the app after a pause tapped there still moves the controller's
  position; one for a song the person replaced since changes nothing.

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
