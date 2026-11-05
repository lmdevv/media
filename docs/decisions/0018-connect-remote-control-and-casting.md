# 0018. Put remote control and casting in the core and keep third-party support small

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with Connect as built.
- Decisions: D35, D44

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

The CLI has them as `media auth player report`, `media auth player requested`,
`media auth targets list`, and `media auth targets control --device-id <id> --playing false`.

### State

Connect keeps two rows per device. Each row has one writer.

- `connectPlayers` is what the device last reported: the session that reported, the output, the
  playback (`domain`, `playing`, `positionMs`) or null when it plays nothing, the newest request
  revision it applied, and the server time of the report. Only `report` writes it. The session
  names the device, so no call names a device it is not on. A session on no device, such as an
  API key, has no player.
- `connectRequests` is the playback controllers last asked for: the session it was made for, a
  revision, and `playing` with `positionMs` held at server time `at`. Only `control` writes it.
- Neither lives on `devices`, because `liveSession` reads the device row on every authenticated
  call. A report on the device row would run every query of every session on that device again.

A request is a desired state, not an event. `control` reads what the device plays now, applies
the change at the current server time, and stores the result with the next revision. The device
moves to the newest request it has not applied: it seeks when it is more than about a quarter
second off, plays or pauses, then reports with `applied` set to that revision. Asking twice gives
the same state, and a device that misses a request in between still ends where the last one says.

What controllers see is merged when they read it. A request stands in for the report while its
revision is above the one the device applied and it was made for the session that reports now.
Otherwise the report stands. A late report with an older revision does not undo a pause.

### Rules for reports and requests

- A request is for the playback of the session that was reporting when it was made. When another
  tile opens on a shared TV, or someone else signs in on the app, the new session reports and none
  of the earlier requests apply to it.
- `applied` never goes down for the same reporting session. An app that restarts and reports
  `applied: 0` keeps the requests it applied, and `requested` stays null.
- A new request's revision is above the last request's and above any revision the device claims
  to have applied, so no request is born already applied.
- `control` refuses a device whose reporting session ended or that has not reported for 30
  seconds (`conflict`, "That device is offline"), and a device that plays nothing (`conflict`).
  So no request waits for a device to come back and then fires late.
- `list` shows the devices that reported in the 30 seconds before it ran, and only while the
  session that reported is live. A subscribed query runs again when any device reports, not as
  time passes, so a client also treats a target silent for 30 seconds as offline by its
  `reportedAt`.
- Changing a device's mode or removing it deletes both rows in the same transaction as the change
  (`dropConnect`, called from the registry's `purgeLeftovers`). The sessions on the device end
  with the same write, so a command in flight fails `not_found`, and the device's next report
  fails `unauthenticated`.
- Devices report on every change and at least every 10 seconds while the app is open. A report
  is anchored at the server time it arrives. Reports from one client must arrive in the order sent.
  The websocket client sends them in order. Two concurrent reports over HTTP can store the older
  one, until the next report replaces it.

### Who controls a device

`can(principal, "control", device)` reads three facts that `connect/targets.ts` loads:

- the relation: on a personal device, whether the principal has a live session there; on a
  shared device, whether it lists them,
- the domain the device plays, or null,
- the principal's membership in the group session the device plays, with whether that session
  lets them control playback, or null.

| Principal                 | Reaches the device when                                                 | Refused as                                                                           |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A person in the household | the device is their personal device, or a shared device that lists them | `hidden` (`not-signed-in-here`, `unlisted`)                                          |
| A guest                   | the device plays their group session and the session allows control     | `hidden` (`guest`), or `forbidden` (`no-control`) when the session does not allow it |
| A service                 | never                                                                   | `hidden` (`service`)                                                                 |

Then the credential needs `play` in the domain the device plays, or in any domain while it plays
nothing. A `music:play` API key cannot pause a movie. A kid's restrictions do not change control.
A refusal that is `hidden` fails `not_found`, so another person's personal device reads the same
as a device that does not exist. `list` shows only the devices `control` would allow.

A Cast or AirPlay receiver is the output of the device that drives it: `{ kind: "cast",
receiver }` or `{ kind: "airplay", receiver }`, where Safari may leave the AirPlay receiver
unnamed. The receiver cannot sign in or run our code, so it is not a device. It shows in `list`
under the driving device's name and is controlled under that device's rule. The driving device
applies requests through the Cast or AirPlay sender, as it applies them to its own player.

### Delay

On an idle dev stack, 100 pause and play commands from a phone to a shared TV, both on websocket
clients, after 5 warm-up commands, took 22 ms at the median and 28 ms at p95 from sending the
command to the TV's subscription seeing it. From sending it to the TV's report of it committing,
they took 44 ms at the median and 54 ms at p95. `test/core/connect/perf.test.ts` measures both
on one clock and fails above 250 ms at p95.

### Not built yet

- Group sessions (ADR 0017) are not on main, so no device plays one and the membership fact is
  always null. Guests cannot sign in until share links exist (ADR 0007). The rule for guests is
  in the table and its tests. When group sessions land, a device's report names the session it
  plays, and `connect/targets.ts` reads the principal's membership for that fact.
- Whether a household member who is in a group session without its control permission may still
  pause a shared device that plays it. Today the household rule decides for every household
  member. The group-session work settles it.
- What plays. Connect carries the domain, not the item, because domain item ids do not exist in
  this deployment. The movies and music ports add the item as the typed item reference group
  sessions use, so the core has one way to name an item.
- Loading an item onto another device and moving playback from one device to another. Both need
  the item and a play check on it, so they come with the ports.
- Remote volume. The device's volume is a per-device setting (ADR 0019), and Connect does not keep
  a second copy.

### Edge cases settled in the build

- A command to a device removed in the middle of it fails `not_found`, and its rows go with the
  device.
- A pause sent to a TV whose tile changed before it applied the pause does not pause the next
  person's playback.
- An admin does not control a shared device that does not list them, and does not reach another
  person's personal device.

Rejected in this build:

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
