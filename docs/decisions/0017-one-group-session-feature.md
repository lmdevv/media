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
  and takes out one's own. Items enter a session only through `create` and `add`, so control alone
  never changes what plays except by skipping to what was queued.

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
  last, and `next` plays the first from its start and takes it out of the queue. Phase 6 adds
  reordering where a client needs it.
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
