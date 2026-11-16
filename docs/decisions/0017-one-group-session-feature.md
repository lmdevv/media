# 0017. Build group sessions once in the core and let each domain supply its state

- Status: Accepted, 2026-11-03
- Decisions: D34

## Context

Both products let people play together, each in its own way. Movies has watch rooms. A room holds
a shared clock (`positionAtAnchorMs`, `anchorServerTime`), heartbeats keep members present, and the
host alone controls playback (`docs/decisions.md`, "Watch rooms"). Music has jams. A jam is a live
listening session shared from its host's playback, people who join play the host's queue, and jam
links can make guest accounts.

The membership, roles, presence, and clock are the same problem in both. The shared state differs.
A movie session shares one title and a position. A music session shares a queue.

## Decision

- The core has one group-session feature with:
  - a join link,
  - members, with host and guest roles,
  - join settings of open, approval, or locked,
  - permissions to control playback and to add items,
  - presence,
  - a shared clock.
- Each domain supplies its own shared state.
- Each client runs sessions for its own domain only. The movies app runs movie sessions.
- Session items are typed references, so mixed sessions could come later.

## Consequences

- Movies' rooms and music's jams both port onto the core feature, in phase 6.
- A join link that a guest opens goes through the guest rules in ADR 0007.
- A later product brings its own shared state and reuses membership, presence, and the clock.
- No client shows a session from another domain in v1.

## Alternatives rejected

- Separate rooms and jams per product, as today. One core feature replaces both.
- Mixed movie and music sessions now. Typed items leave room for them, and v1 does not build them.

## Edge cases settled

- A locked session takes no new members.
- An approval session holds a new member until the host approves.
- A member without the control permission cannot change playback. A member without the add
  permission cannot add items.
- The movies app never opens a music session, and the music app never opens a movie session.

## Group sessions as built (amended 2026-11-04)

The commands are in `packages/platform/convex/core/together.ts`, and the rest of the module is in
`convex/core/together/`. The rules are in `convex/core/permissions/policy.ts`, and the item loaders
are in `convex/core/permissions/items.ts`. Phase 3 wires no client to it (D50). The movies and
music clients adopt it in phase 6.

### Sessions and members

- A session belongs to one domain, its item's. A person has at most one row per domain: the
  session they are in, wait to join, or saw end. Every command takes the domain, or an item that
  carries it, and none takes a session id. So the movies app can only reach a movies session.
- Joining or starting a session leaves the person's place in another session of the same domain.
  It fails `conflict` while they host a live one there.
- The host is the person who started the session, and it never changes. Everyone else in it is a
  guest, whatever their platform role. The host leaving (`core.together.leave`) ends the session
  for everyone. A guest leaving removes only them.
- A platform guest (ADR 0007) becomes a member through `enter` in `together/members.ts`, the one
  insert path, when they open a share link that names the session. Member rows hold a `users` id,
  so guests need no schema change. `can` refuses a platform guest the join link.
- Sessions hold at most 50 members and 20 people waiting. The host can remove anyone, or turn a
  request away (`core.together.block`). The link then refuses them for the session's life, up to
  100 people. Past 100, `block` still takes the person out and then fails `conflict`, telling the
  host to lock the session, because the link could let them back in. `block` is an action that
  removes in its own mutation, so a full list never rolls the removal back.

### The join link

- The link is `mt_<sessionId>.<secret>`, with 24 random bytes made in the `create` action. It is
  stored as made, unlike invite and reset codes (ADR 0003). Every joined member can copy it again
  from `core.together.get`.
- The link opens nothing on its own. It lets a signed-in household person join under the session's
  setting, and each item is still checked against that person's own grants and restrictions. A
  leaked link is answered by switching to approval or locked, so there is no rotation.
- Joins are rate limited to 60 an hour per person. Only arrivals count, so a member or a waiting
  person who joins again is free. A refused join rolls back with its mutation, so only joins that
  succeed count.

### Join settings and permissions

- `open` lets anyone with the link join. `approval` holds them as waiting until the host lets them
  in (`core.together.admit`). `locked` refuses anyone new and lets no one waiting in. Members stay
  when the setting changes, and so do people waiting. A waiting person whose session turns open
  gets in by joining again.
- `control` and `add` are two switches for every guest, set with `core.together.configure`. The
  host may always do both. Control moves the clock and skips to the next item. Add queues items
  and takes out and moves one's own (`reorder`, amended 2026-11-15). Items enter a session only
  through `create` and `add`, so control alone never changes what plays except by skipping to what
  was queued.

### The shared clock

- The clock is `status` (playing or paused), `positionAtAnchorMs`, `anchorServerTime`,
  `playbackRate`, and `revision`. The names match movies' rooms, so phase 6 can reuse their
  follower code. While playing, the position at server time `t` is `positionAtAnchorMs + (t -
  anchorServerTime) * playbackRate`.
- Only `core.together.control` and the host-away pause move it, and every move anchors at the
  server's own time and bumps the revision. No client time and no player report ever enters the
  clock.
  - Play and rate are absolute, so a repeat or a race between two members changes nothing.
  - A pause is absolute too, but it always makes a new revision, a paused clock's as well, as old
    movies' rooms did for every host command (amended 2026-11-15, see "Stall holds" below). Two
    pauses never conflict, since a pause carries no revision. The host-away pause pauses only a
    playing session.
  - Seek and next carry the revision the member saw. An older one fails `conflict`, so two members
    skipping at once move the session on once.
  - A play or a pause may carry a revision too, the one its client decided against (amended
    2026-11-15, see "Moves no one asked for" below). It then applies only while the clock is still
    at that revision, and otherwise fails `conflict` and changes nothing, as old movies' rooms
    fenced every host command. One without a revision applies whatever the clock is.
- This replaces the rooms' host re-anchoring. The host follows the clock like every guest. A
  stalled host player no longer holds the room: a phase 6 client pauses it through `control`.
- `core.together.heartbeat` answers the server's time, so a client estimates its offset from
  heartbeats. A heartbeat writes at most once a second. A burst's later heartbeats write nothing,
  so they are clean samples with no commit in their round trip.

### Presence

- A client sends a heartbeat every 5 seconds while the session is on screen. The heartbeat writes
  only `togetherBeats`, which no subscribed query reads. A member's `awaySince` changes only when
  they go away or come back, so no heartbeat re-runs anyone's view of the session.
- A cron every 10 seconds marks away the members silent for 30 seconds, and drops the people
  waiting who left before the host answered. A host going away pauses a playing session where it
  is. A host away for 30 minutes ends it as abandoned. A guest away keeps their seat.
- An ended session stays readable for an hour, so every member sees that it ended. Then a scheduled
  job deletes its queue, members, and row in batches of 500.

### Items

- `itemTypes` in `packages/commands/src/access.ts` is the one list of item types, each with its
  domain and table. The generator derives `domainItem`, which pairs a domain only with its own
  types. A movies session handed a music item fails the type check, the argument check, and the
  schema alike. `permissions/items.ts` has one loader per type, or it fails to compile.
- Phase 3 listed two types over the `probeItems` seam (ADR 0024), `probeMovie` and `probeTrack`.
  The movies port replaced the first with `title`, `episode`, and `file`, and the music port the
  second with `track` and `album`, and deleted the seam (amended 2026-11-13). A loader answers
  nothing for a row whose library holds another domain's content. An album is never explicit
  itself: a kid's explicit filter hides its explicit tracks one by one, when each plays.
- `create` and `add` take only items the caller can play. `get` and `core.together.queue` show
  each viewer an item they may not play as `null`, such as a kid and an R movie.
- The queue holds up to 500 items to play next, counted in `counters`. `add` puts one first or
  last, and `next` plays the first from its start and takes it out of the queue. The music clients
  added reordering, skipping to a named entry, queueing many items at once (`addItems`), and the
  session fence on `add`, `addItems`, and `control` (amended 2026-11-15, see "Music group sessions
  in the clients").
- `add` with `revision` queues an item that follows the one playing, such as the next episode,
  as old movies' rooms named the episode they moved on from (`fromEpisodeId`). It fails
  `conflict` once the clock moved past that revision, as a stale seek does, and takes out any
  copy of the item already queued, each only if the caller may remove it. Two of a host's
  screens racing to queue the next episode then queue it once, and a late add cannot queue it
  again after the session moved on to it.
- A queue page holds only as many entries as one call can decide inside `PAGE_ROWS_MAX` reads
  (ADR 0005). Each entry may cost its row, its item and the item's library, one grant per key of
  the viewer's reach, and who queued it. That is 44 entries for a person in 16 groups and 164 for
  one in none. A page that a reactive client reloads up to its end cursor holds every entry up to
  it. Past that size, it decides none of them and answers `SplitRequired` at the split cursor
  Convex gives. Convex itself only recommends that split, because it ignores `maximumRowsRead`
  once an end cursor is set.

### Actions added to `can`

| Action    | On       | Needs, always with `<domain>:play` and never a service                      |
| --------- | -------- | --------------------------------------------------------------------------- |
| `start`   | together | not a platform guest                                                        |
| `join`    | together | an open, live session the person was not removed from; not a platform guest |
| `ask`     | together | the same, under approval                                                    |
| `see`     | together | joined or waiting, ended too                                                |
| `view`    | together | joined, ended too                                                           |
| `leave`   | together | joined or waiting, ended too; `account` does instead of `<domain>:play`     |
| `control` | together | the host, or a joined guest when guests may control                         |
| `add`     | together | the host, or a joined guest when guests may add                             |
| `remove`  | together | the host, or a joined guest who may add and queued the entry                |
| `reorder` | together | the same as `remove` (amended 2026-11-15)                                   |
| `admit`   | together | the host, in a session that is not locked                                   |
| `manage`  | together | the host                                                                    |

Someone in no session, or removed from it, gets `hidden` for every action but `start`, `join`,
and `ask`, so a session they are not in reads as none.

### Measured

Two lane clients followed one session, each on its own WebSocket, for 5 minutes of seeks, pauses,
and plays (`test/core/together/drift.test.ts` with `MEDIA_DRIFT_SECONDS=300`). One client's clock
ran 3.7 seconds ahead and 50 ppm fast, with up to 40 ms of extra delay on each reply. Both sampled
the server's clock as movies' rooms do: a burst of 5 every 30 seconds, keeping the shortest round
trip of the last 10. The positions they showed at the same instant differed by 4 ms at p95 and
5 ms at most once settled. The same harness on movies' rooms measured 4 ms at p95. In an earlier
run, the clients counted every heartbeat as a sample. Heartbeats that write wait for their commit
on the way back, which biased the estimate, and the p95 rose to 5 ms against the rooms' 3 ms. The
stack suite runs the test for 30 seconds.

The queue was measured at its worst case in `test/core/together/perf.test.ts`. Its 240 items come
from 240 libraries, and the viewer is in 16 groups with a grant through each. Before the fix, the
first page failed with Convex's "Too many reads" (limit 4,096) after reading 7,908 documents,
because each library's check read the viewer's groups again. Now a page holds 44 entries and reads
901 documents. A reload grown to 89 entries read 109 and asked for a split. The pages it split into
read at most 901.

### Edge cases settled in the build

- A heartbeat to an ended session writes nothing, and one from a person who left fails
  `not_found`.
- A queue entry already gone is no change, so two members taking it out at once both succeed.
- A host cannot remove themselves. They leave, which ends the session.
- Asking to join another session of the same domain gives up the person's current seat, as joining
  does, because a person holds one place per domain.
- A kid can join a session whose item their restrictions hide. They see the clock, the members,
  and a hidden item, and tickets refuse the stream.

Rejected in this build:

- Host re-anchoring from heartbeats, as movies' rooms do. Every re-anchor wrote the session, so
  every member's view re-ran on the host's jitter, and the host's network delay became everyone's
  error.
- Presence as a `lastSeenAt` on the member row. Every heartbeat would re-run every member's view.
- Control and add per member. Nothing in the spec asks for it, and it would fan writes out over
  every guest when the defaults change. An optional field on the member row can add it later.
- A hashed join link with rotation. It would hide the link from members and from the host's other
  devices, and the link grants nothing a household person's own grants do not.

Left for later units:

- Phase 6: players and their follower policy (movies' `DRIFT_THRESHOLDS`), buffering, end of item,
  the next-episode countdown, autoplay, history, and moving `positionAt` and the timings into
  `@media/contracts` for the clients.
- p3-guests, done: see "Guests in group sessions" below.

## Guests in group sessions (amended 2026-11-06)

- The host shares a session with `core.guests.links.create({ target: { kind: "session", domain }
  })`. The link names the session they host by id.
- Opening the link decides `join`, then `ask`, with the new `invited` fact, and enters the guest
  through `enter` under the join setting. Open joins, approval waits for the host, and locked
  refuses. A blocked guest stays out. A guest never enters through an `mt_` join link.
- A platform guest plays the session's item and what its queue holds, at the host's level: the
  host's grants and restrictions are the ceiling. `can` refuses a platform guest `add` and
  `remove` (`platformGuests` in the rule table), since a guest cannot browse for anything to add.
  `control` follows the host's switch, as for every guest.
- `core.together.get` marks each member who came through a share link `linkGuest`.
- Revoking the link takes its guests out of the session, so a leaked link cannot keep seats. A
  guest member counts only while their link holds: `get` lists no guest whose link died, the seat
  count skips them, and the next `enter` deletes their row, whether or not they still send
  heartbeats. The presence sweep also drops a silent guest whose link stopped holding.
- Blocking a guest removes that guest, but the link can let its holder in again under a new name.
  The host revokes the link or locks the session to keep them out.

| Action          | On       | Change                                                |
| --------------- | -------- | ----------------------------------------------------- |
| `join`, `ask`   | together | a platform guest needs the `invited` fact             |
| `add`, `remove` | together | refused to a platform guest, whatever the host allows |

## Movie group sessions in the clients (amended 2026-11-15)

The movies web client and the movies iOS app run movie group sessions, as old movies' watch rooms
did, over the commands above. The core changes in four places. `add` takes `revision`, a pause
always makes a new revision, and a play or a pause may carry a revision, all above. And one read,
`movies.titles.episode`: an episode
item names no show, and starting playback names both, so a member resolves it. It needs
`movies:play`, not `movies:read`, and answers whoever may play the episode as `movies.play.start`
decides it, so a platform guest reads the episode their session or link covers and nothing else.

### The shared clock code

`@media/contracts` holds what every client runs, and the music clients reuse it:

- `clock`: `SessionClock`, `positionAt`, the heartbeat and away timings, the sampling of the
  server's clock (a burst of 5 heartbeats every 30 seconds, the shortest of the last 10 round
  trips), `DRIFT_THRESHOLDS`, and the next-episode countdown.
- `follower-policy`: `follow`, movies' rooms' correction policy (in step within 120 ms, a rate
  nudge of 5% up to 1.5 s, a seek beyond it), with the end of the player's own media as a ceiling,
  since members may play versions of different lengths.
- `follower`: the follower, an Effect over a player port and a session port.
- `session-next`: the end of an item, below.

### Following

- Every member follows the clock, the host included. A client sends a heartbeat every 5 seconds
  from any screen while the person is in or waits for a session, so browsing elsewhere keeps their
  seat and keeps a host's session playing; closing every tab stops it, and 30 seconds later a host
  away pauses the session. The iOS app sends it while the app runs, which iOS allows in the
  background only while it plays or shows picture in picture, so a host watching there stays
  present, as old rooms' player reports kept them.
- A member who may control plays, pauses, and seeks through `control`. The player moves at once,
  and corrections wait for the answer. A refused move, or a seek against an older revision, leaves
  the player to return to the clock. The controls of a member who may not control show who can,
  and their keyboard shortcuts are refused. A move they make outside the controls, such as a seek
  from picture in picture, is corrected; a pause there detaches them until they play.
- Clocks arrive from the subscription and from each answer; only a higher revision is applied.
- The host's player pauses the session where it stalled, after a second of waiting, and plays it
  on once it recovers, under the rules in "Stall holds" below. A stall right after the follower's
  own seek does not count. Guests catch up on their own.

### Moves no one asked for

A client's view of the session is always behind the core's: a move someone made on another screen
reaches it one subscription later. So a client never decides on its own, from what it can see, to
override the session. Every move a client makes that no person asked for carries the revision it
was decided against, and the core applies it only while the session is still there. Otherwise it
fails `conflict` and changes nothing, and the newer clock, on its way, decides what happens next.
A move a person asks for carries none, so a host's deliberate pause or play always wins.

| Move                                              | Made by                  | Carries                            | When the session moved on                         |
| ------------------------------------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------- |
| A stall's pause                                   | the host's follower      | the revision the player stalled on | refused, so no hold                               |
| A stall's seek back to where the player stalled   | the host's follower      | its pause's revision               | refused, so the session stays paused at the pause |
| A recovered hold's play                           | the host's follower      | the hold's own last revision       | refused, and the newer clock ends the hold        |
| Queueing the next episode in the credits          | the host's client        | the revision it decided on         | refused                                           |
| Moving on at the end of the countdown or the item | the host's client        | the revision it decided on         | refused                                           |
| Pausing at the end of an item with nothing next   | the host's client        | the revision it decided on         | refused                                           |
| A play or pause from the controls or the player   | a member who may control | nothing                            | applies                                           |
| A seek from the controls or the player            | a member who may control | the revision they saw              | refused, and the player returns to the clock      |

A refused move is safe to try again, since it can never undo anything newer: the follower tries a
hold's play again on its next correction tick, and the client its end-of-item moves after two
seconds, each against the newest clock it has by then.

### Player events

A player reports events late. A native bridge delivers them after the fact, and a pause or a seek
takes effect some time after the follower asks for it. No event says which clock it came from, so
the follower judges events against the commands it gave the player, not against clock revisions.

- The follower numbers every command it gives its player: each play, pause, and seek, and the
  load it starts on. It keeps the state the player should be in after the latest one, and the
  commands still pending: the load, the latest play or pause, and the latest seek.
- A command stays pending until its event arrives: `playing` for a play, `paused` for a pause, and
  `seeked` for a seek, wherever it landed. A correction that finds the player where the clock wants
  it also ends a pending command. A seek waits out the 3 second seek cooldown for its `seeked`,
  because a slow seek can land somewhere else. A load has no event, so the first correction that
  finds the player in place ends it.
- `hear` in `follower-policy` judges each event when it arrives, against the commands given so far:

| Pending when it arrives | Event                                                    | It is                    | Moves the session |
| ----------------------- | -------------------------------------------------------- | ------------------------ | ----------------- |
| a command               | the event that shows a pending command carried out       | that command's echo      | never             |
| a command               | any other                                                | the player catching up   | never             |
| nothing                 | a play or pause that matches the expected state, a stall | no change                | never             |
| nothing                 | a play or pause that differs from it, or any `seeked`    | the viewer or the player | as below          |

- `eventAction` is the one place that decides what an event does, and it decides once, when the
  follower handles the event, not when the player reports it (amended 2026-11-15). Events wait in
  a queue in between, and a newer clock can reach the follower and move the player in that time.
  Each event keeps the number of the follower's latest command when it arrived. If the follower
  has given its player a play, pause, or seek since, the event is stale, whoever caused it: a
  viewer's `playing` still queued when a newer paused clock pauses the player never plays the
  session again. Otherwise only a change moves the session, and only while the player still stands
  where the event says. The first row that matches decides:

| Event              | When the follower handles it                                                | Action                                                |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| a stall or an end  |                                                                             | nothing                                               |
| any other          | the follower gave its player a command after the event arrived              | bring the player to the clock                         |
| a `playing` change | the player plays now, the session is paused, the viewer may control         | play the session                                      |
| a `paused` change  | the player is paused now, the session plays, no hold, not at the end        | pause the session, or detach a viewer without control |
| a `paused` change  | the session is already paused, a hold holds it, or the player is at its end | nothing                                               |
| a `seeked` change  | the viewer may control, and the player landed over a second off the clock   | seek the session there                                |
| any other          |                                                                             | bring the player to the clock                         |

- That includes a viewer's own quick second move on the player. If they pause and then play
  within one round trip, the answer to the pause moves the player before the follower handles
  the play, so the play is stale and the session stays paused. Before this rule, the web dropped
  it too, as its player had already paused, and only the iOS app played on, because AVPlayer
  takes a pause late.

### Stall holds

The host's player pauses the session where it stalled: a pause, then a seek back to where it
stalled. `holdStands` in `follower-policy` is the one place that decides whether a hold may play
the session on. It judges the hold against the newest clock the follower has, which can lag the
core's, so only a clock newer than the hold's own last move ends it (amended 2026-11-15):

| The follower's newest clock         | The hold                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| older than the hold's own last move | stands, and waits for the clock to catch up, as when a follower started after a stream reload from a subscription that has not shown the hold's pause or seek back yet |
| the hold's own last move            | stands, as that move left the session paused                                                                                                                           |
| newer than the hold's own last move | ends: someone moved the session, or the hold's own play answered                                                                                                       |

| Step                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taking the hold              | The pause carries the revision of the clock the player stalled on, and the core applies it only there (amended 2026-11-15). If someone else's move came first, a pause included, the core refuses it, the session stays as they left it, and there is no hold.                                                                                                                                                                                                                                                                                                   |
| Playing on                   | Once the player recovers, while the hold stands, even before the follower's clock shows the hold's own move. The follower checks this when the pause lands, on every newer clock, when a new follower takes the hold over, and before the play. The iOS player screen checks it through the same takeover rule when a new playback attempt starts. The play carries the hold's revision, so the core refuses it once anything moved the session since, even a move the follower has not heard of yet: a deliberate pause made while its clock lagged still wins. |
| A pause that changes nothing | The core gives every pause a new revision, so a pause someone asks for during a hold always ends it. Under the old rule it left no trace: a session held alone and one also paused by its host end up identical.                                                                                                                                                                                                                                                                                                                                                 |
| A stream reload              | The pause runs on without its follower. A follower replaced while the pause is on its way, as on a stream reload, takes over the hold, under the same rules once the pause lands. The iOS app starts a new playback attempt for a new stream, which mounts a new follower, so its player screen keeps the hold across attempts, and an attempt that starts while the hold stands starts playing, since the hold plays the session on only once its player plays.                                                                                                 |

### The end of an item

The core keeps no countdown, so the queue carries it. In the credits of an episode (its last
tenth, at most 30 seconds) the host's client queues the next episode first, against the revision
it decided on, so the core queues it once across the host's screens. Every member who sees
it first in the queue counts down on the session's clock, so a pause holds the countdown. When it
ends, or the item ends, the host's client skips to it; a member who may control can skip sooner.
Watch credits, the host's, takes the entry out, which stops everyone's countdown. At the end of an
item with nothing next to an episode, the host's client skips to whatever is queued, or pauses the
session at the end, against the revision it decided on, as every move no one asked for does. Each
member's player reports its own progress, so history is each person's.

### Links

The web client opens `/movies/together#<link>`, joins, and plays the session or says why it waits:
for the host's approval, a locked or ended session, or an item the person may not watch, whose
place they keep. The link travels after `#`, as invite links do (ADR 0020), so no request,
referrer, or server log carries it, and the page drops it from the address once read. The iOS app
opens `movies://together/<link>` the same way and shares the web address. The host starts a
session from the player, with the link to copy before it starts.

### Differences from old movies' rooms

- Guests see a paused session while the host's player stalls, not "Waiting for the host's
  connection": the clock has no buffering state.
- Members see only their own drift, since heartbeats report none.
- The countdown holds while the session is paused, and a host who reloads during the credits after
  Watch credits may see it start again.
- Queueing (Up next) and the join and guest switches are new to movies, from D34.

## Music group sessions in the clients (amended 2026-11-15)

The music web client and the music iOS app run music group sessions as old music's jams, under
old music's name for them, Jam, over the commands above. The music player plays a session through
the same controller and engine as the person's own queue (`packages/player/src/session-playback.ts`)
and follows the clock with the follower in `@media/contracts`, unchanged. The engines take a
playback rate, keeping the pitch, so a follower nudges a small drift instead of seeking; the
shared defaults hold (in step within 120 ms, a 5% nudge up to 1.5 s, a seek beyond).

### The core

Each change comes from what old jams did, or from a verifier's finding against it (fix round 1):

- `core.together.reorder` moves a queued entry to just after another, or to the front. `can`'s
  `reorder` follows `remove`'s rule: the host any entry, a guest who may add only their own, as old
  jams by default let people move the songs they added. An entry gone is no change; an anchor gone
  fails `conflict`. An entry takes an order between its new neighbours; once no number is left
  between two, the call renumbers the queue, at most 500 entries.
- A skip (`control`'s `next`) takes an optional `entryId` and plays that queued entry, leaving the
  ones before it queued, as old music let a person play any song in the queue. It carries the
  revision as before.
- `get` answers `entryId`, the queue entry the playing item came from (stored as `itemEntryId`),
  or null for the item `create` started with. Two plays of one song differ by it, so a player that
  moved on by itself to the entry queued first knows when the session moved there too.
- A skip starts the next item as far in as the clock played past the end of the one it leaves
  (`carriedPast` in `together/clock.ts`), for a music track, whose length the core knows. Every
  member's gapless engine moves on by itself at that end to the entry queued first, which it
  preloaded, before the host's skip reaches the core, so that song starts for the core when it
  started for the players. The carry belongs to that one successor, so the core keeps its
  identity: the session stores `queuedFirst`, the entry queued first and the server time it got
  there, and every write to the queue keeps it in the same mutation. A skip carries only into the
  entry that was queued first 3 seconds (`FIRST_BY_MS`) before the clock reached the end, about
  the longest a player takes from the write to holding the song preloaded, and still is (table
  below). An add in front, a removal of the entry before it, or a move later than that puts a song
  first that not every player preloaded, so it starts at 0 and no one misses its start (fix round
  1: a song added 5 seconds after a session ran past its end started 5 seconds in). The host's
  move at the end names no entry, so an entry taken out at the end is no reason to wait: it plays
  what is first, from 0 when that is new. Each writer works out the entry it leaves first from
  what it read before it wrote anything: in a Convex mutation, a limited index read after a write
  to its range can answer a moved row where it stood, or skip a row after a delete and an insert.
- `add`, `addItems`, and `control` take a `sessionId`, the session the call was made for, which
  `addItems` requires. With it the call fails `conflict` before anything is decided once the
  caller's place in the domain is in another session or in none: they left it, or it ended and
  they started or joined another. A session that ended with them still in it decides as ended, as
  before. The music clients name their session on every add and every move, so nothing made for
  one session lands in the one that replaced it (fix round 1: songs a long queue was still adding
  to Jam A landed in Jam B).
- `core.together.addItems` queues up to 500 items at the end, in order, as many as one call can
  decide within `PAGE_ROWS_MAX` reads (196 for a person in no group, 46 for one in 16) and the
  queue's room, leaving out any the caller may not play, and answers how many it took (`taken`),
  so the caller sends the rest again. A host's player fills a new Jam with it in a few calls,
  where it used to add one song a call.
- `get` answers each person's display name beside their username (`hostDisplayName`, and
  `displayName` for members and people waiting), and `core.together.queue` who queued each entry by
  both (`addedByDisplayName`). The clients show the display name, or the username without one
  (#149), and add the username where a host acts on someone, as two people may go by one name.

| A skip that lands past the end of a song plays                               | It starts                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| the entry queued first since 3 s before the clock reached the end            | as far in as the clock ran past the end, at most 10 s and short of its end      |
| an entry queued first only later, or since that end                          | at 0: an add in front, a removal of the entry before it, or a move put it there |
| another entry, as one further down the skip names                            | at 0                                                                            |
| anything, on a clock paused, moved since it reached the end, or 10 s past it | at 0                                                                            |
| anything, before the end, or leaving an item of no known length, as a movie  | at 0                                                                            |

| Move                                                        | Made by                  | Carries                                     | When the session moved on                                                                    |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Moving on to what is queued at a song's end                 | the host's player        | the revision it decided on                  | refused, and the newer clock decides; the carry only into the entry first 3 s before the end |
| Pausing at the end of the last song, then back to its start | the host's player        | the revision, then the pause's for the seek | refused, and the session stays as it is                                                      |
| Moving a session paused past a song's end on, paused        | the host's player        | the revision it decided on                  | refused                                                                                      |
| Playing a queued song now                                   | a member who may control | the revision they saw                       | refused, as a stale skip                                                                     |
| Any add, play, pause, seek, or skip from a music client     | the client               | the session it was made for                 | refused once the person left it, it ended, or another replaced it                            |
| Queueing the songs after the first when a Jam starts        | the host's player        | the session `create` made                   | refused, and the fill stops for good                                                         |

### Playing a session's queue

The session reaches the player as a queue: the playing entry first, then what is queued, up to the
first entry whose song the player has no details for yet or that is hidden from the person, so the
engine never preloads a song that does not play next. The gapless engine preloads the entry queued
first and moves on to it by itself at the song's end. Only the session moves the session on. One
rule decides what a player does with its own move, in the controller's `#syncSession`, against
each new view of the session:

| The engine                                     | The session's playing entry | The player                                         |
| ---------------------------------------------- | --------------------------- | -------------------------------------------------- |
| moved on by itself from entry S to the next, E | still S                     | plays E on, ahead of the session                   |
| moved on by itself from S to E                 | E                           | plays E on without a reload: the session caught up |
| moved on by itself from S to E                 | any other                   | loads the session's entry where its clock stands   |
| plays the session's entry                      | the same                    | follows the clock                                  |
| plays another entry, or none                   | any                         | loads the session's entry where its clock stands   |

A follower is made for one playing entry and one load of it, and stops as soon as either changes;
it starts once the engine holds that load's source, whether or not the engine has reported the
start yet: the iOS engine reports it on its next status update, after the load resolved. While the engine plays ahead in E, the
follower of S reads the player as standing at S's end, which the follower policy leaves alone
while the session's position is past it. A seek it asks for back into S loads S there, as the
session never moved on; a seek to S's end leaves the engine where it is. The engine's events reach
the follower of the entry they belong to, the one moved on from while ahead, and moving on to the
preloaded song is that entry's end.

### The end of a song

The host's player moves the session on, on the session's clock, never on its own engine's end:

| The session's clock        | Queued    | The host's player                                                                                        |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| playing to the song's end  | something | skips to it 40 ms after the end, and the core carries the time past it                                   |
| playing to the song's end  | nothing   | pauses it, then takes it back to the song's start, as old music's player stopped at the end of its queue |
| paused past the song's end | something | skips to it at once: the next song waits at its start, paused                                            |
| paused past the song's end | nothing   | takes it back to the song's start                                                                        |
| anything else              |           | nothing                                                                                                  |

It decides once per clock revision. A move refused or lost is tried again after 2 seconds against
the newest clock, so a person's pause made meanwhile always stands. A guest's player never moves
the session at a song's end; it waits there, at the end of its song, until the session moves on.

### Starting, joining, and the queue

- The host starts a Jam from the song playing: `create` on it, a play when it played, and a seek to
  where the song stands, read as late as possible, each naming the session `create` made. The
  songs queued after it then join the session's queue in order through `addItems`, a few calls for
  up to 500, each naming the session; the first refusal, as once the session ended or the host
  left it, stops the fill for good. The song goes on without a gap.
- Joining stops the person's own song where it was, and it waits, paused, until they leave or the
  Jam ends; waiting for the host keeps it playing. The web opens `/music/jam#<link>` and drops the
  link from the address; the iOS app opens `music://jam/<link>` or a pasted link. The host shares
  the web address, with a QR code.
- Heartbeats run on every screen while the person is in or waits for a Jam: on the web while a tab
  is open, in the iOS app while it runs online.
- Play, pause, seek, and skip go to the session for a member who may control; anyone else is
  refused with old music's `The host controls playback in this Jam`. Previous starts the song
  again: a session keeps no songs it played.
- Adding needs the host's switch (`The host turned off adding songs in this Jam`). Playing a song
  or a list now, with control and add, queues its first song in front and skips to that entry at
  once, then queues the rest after it, up to 100 songs; the rest of the queue stays after them.
- A guest who may not control and whose player something outside paused, as a call, sits out
  until they play it again, from the player or the system controls; it then follows the clock.
- A host's player plans no end for a song whose length is unknown; someone skips it. A host who
  may not play the song playing, as a kid host and an explicit song a guest queued, has no length
  to plan by either, so the Jam waits at that song's end until someone skips.
- The clients follow every page of the session's queue, loading the next as soon as one arrives,
  as they follow the listener's own queue (`useQueueListing`), and keep the last whole listing
  while the pages load again, as when one splits or fails: a page holds only as many entries as
  one call can decide, and before fix round 1 the clients read only the first, 50 entries of a
  500-song queue. So members see, take out, and the host moves every entry, on the web and on iOS.
- The queue shows who added each song, by display name. An entry the person may not play shows as
  `Hidden song`, as for a kid and an explicit song, on the web and, since fix round 1, on iOS. A
  hidden playing song plays nothing for them for its length: their player stays silent and shows
  `Hidden song` (Now Playing, the mini player, and the iPad bar on iOS), and a guest's player never
  moves the session on. The host's player moves it on at the song's end, on the clock, unless the
  song is hidden from the host too (above).

### Connect in a Jam

A device that plays a group session is controlled through the session, not by Connect (D35,
ADR 0018). Following a session, or going back to the person's own queue, is the listener's action,
so the Connect requests seen so far are moot, as after a tap. The controller's `followsSession` is
read as each request applies:

| What reaches the device                                                                   | The device                                                      |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| a Connect play, pause, seek, load, or stop, while it follows                              | settles it at once and applies nothing; the session plays on    |
| a load still starting, for the queue or an album's songs, as it starts or stops following | drops it and settles it                                         |
| the answer to a new queue it was writing, once it follows or stopped following            | plays nothing                                                   |
| another of the person's devices playing, or another tab taking the browser's lead         | keeps the session's song                                        |
| a seek the session's follower makes                                                       | is not the listener's action, so Connect's requests still stand |

In a Jam the player offers no other device to move to or play on: each of the person's players that
follows the session plays it, and a move carries an item, not a session. The Play on list shows
this browser and the Jam button, as old music's did. A device that follows reports the song it
plays, without the session: only a guest's decision reads it (D35), and guests have no client
sign-in yet.

### Measured

Live on the image, desktop Chromium pages sampled their audio every 100 ms; the drift is |a - b| at
common instants while both play one song, over the 5 minutes after the members joined, across a
gapless song change. Old music's jams ran from `bd7462a7` on `media:0.3.0`, Lucía hosting and Aiko
listening along, on the same album, song, and queued song. Blocks alternated: head, old jams, head,
and a third head block on the final code. The head's first and third blocks had two members.

| Measure                                | Old jams | Head, block 1 | Head, block 2 | Head, block 3 |
| -------------------------------------- | -------- | ------------- | ------------- | ------------- |
| p95 drift, host and member             | 149 ms   | 46 ms         | 23 ms         | 10 ms         |
| p95 drift, two members                 |          | 7 ms          |               | 5 ms          |
| spread of the song change across pages | 90 ms    | 39 ms         | 18 ms         | 10 ms         |

The host's own song, kept without a gap when the Jam starts, stays where the follower's 120 ms
in-step band leaves it, 5 to 42 ms off the clock here; members load at the clock and settle within
a few milliseconds. In three of the four song changes, from a FLAC song to an MP3 one, one page's
audio held about 50 ms, a member's in old jams and the host's in two head blocks, and its follower
made it up within 2 seconds.

The music iOS app on a simulator joined by its link and followed with a clock offset of -8.5 ms
over a 33 ms round trip; its Now Playing label turned each second within the probe's own delay of
the session clock. Before the follower started on a load that the engine had not reported yet, the
app played about a second behind.

### Differences from old music's jams

Each was decided under D34, the core's one session model (join settings open, approval, or locked;
permissions control and add), or moved to the owner's backlog under D62:

- No limit on the songs each person has coming up; the core has the add switch only. Backlog
  (D62).
- Moving and taking out songs follows `remove`: old jams let the host choose nothing, their own, or
  anything. Decided under D34.
- No listen-along switch: every member's player follows the session. Decided under D34.
- No new link: the core keeps one link per session; the host locks it or asks for approval.
  Decided under D34; regenerating a link is backlog (D62).
- No end after four idle hours; the core ends a session whose host is away for 30 minutes.
  Decided under D34.
- No guest accounts from a Jam's link. Backlog (D63).
- No autoplay or shuffle and repeat in a Jam; it stops at the end of its last song. Backlog (D62).
- A member whose grants do not reach a song's library hears nothing for it, under this ADR's item
  rule; old jams streamed every song the host played to everyone in the Jam. Decided under D34.
- The iOS app has no QR scanner, so a link is opened or pasted. Backlog (D62).
