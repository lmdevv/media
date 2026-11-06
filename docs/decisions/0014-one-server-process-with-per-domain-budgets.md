# 0014. Run one server process with per-domain worker caps and one transcode limit

- Status: Accepted, 2026-11-03
- Decisions: D29

## Context

Movies and music each run their own media service with their own ffmpeg children, scanner, and
limits. On one server, a music rescan and a movie transcode compete for the same CPU, disk, and
memory. Movies' NixOS module runs its media service under a system call filter, and both products
mount media read-only.

## Decision

- One server process runs worker pools and ffmpeg child processes.
- Each domain has its own caps, so a music rescan cannot starve a transcode.
- Each job kind runs in one pool, and each pool has its own cap. Music adds its pools in phase 5.

  | Pool                | Job kinds                         | Cap                     |
  | ------------------- | --------------------------------- | ----------------------- |
  | `movies`            | scan, metadata, person, migration | 2                       |
  | `movies.background` | trickplay                         | `TRICKPLAY_CONCURRENCY` |
  | `server`            | backup                            | 1                       |

- One server-wide transcode limit covers every domain. Guests have the lowest priority under it
  (ADR 0007). The remux limit follows the same rules.
- Media mounts stay read-only.
- The sandbox stays.

## Consequences

- The deploy runs one server process. Domains share hardware through its pools.
- Adding a domain means adding its pools and caps, not a new service.
- A transcode limit reached by household streams leaves no room for guest streams.
- The server never writes to a media mount. Temporary segments go to the server's own folder.
- `scripts/check-sandbox.sh` keeps running the server's tests under the module's system call
  filter.

## Alternatives rejected

- One media service per domain, as today. The product is one server (ADR 0002).
- A shared pool for every domain with no caps. A music rescan could starve a transcode.

## Edge cases settled

- A rescan that hits its domain's cap waits. It does not take a transcode's slot.
- A job whose pool is full stays pending. It never takes another pool's slot, so scrub thumbnails
  never hold up a scan, and a backup never waits for one.
- A guest stream is the first to wait when the transcode limit is reached. The core's
  `core/tickets:sessionStatus` answers `guest: true` for a guest's session, so the server knows a
  guest's stream from the ticket's session alone (ADR 0007).
- Waiting guests form one line, served by ticket, the negotiation that started each stream. A
  guest that resumes its stream keeps its ticket, so it goes ahead of guests that started later.
- A household stream that finds the limit reached while guests hold slots takes the newest guests'
  slots until it fits, preferring guests whose encoders already run over ones still starting. Each
  such guest's encoder stops, even mid-start or under a waiting request, and its session stays.
  Its next segment request waits in the line. A guest whose encoder has not started gives up its
  start instead. Household streams leave the limit as it is when guests' slots are not enough.
- A taken slot counts as part of the stream that took it, and so does the slot of a stream that a
  newer one in its session replaces. If the taker leaves before that slot is free, the slot passes
  to whoever took the taker's own slot, and a guest's slot that passes to a household stream
  yields as a taken one does. Failing that, it counts on its own.
- An encoder starts only while fewer encoders than the limit run, counting every one not yet
  stopped. Taken and replaced encoders that are still stopping hold back the streams that took
  their slots, so the limit is never exceeded.
- Every ffmpeg run holds its own slot, and the slot frees only once the server knows the process
  exited. A seek or a resume starts a new run in the stream's own place. While the limit is
  reached, that run starts once the stream's previous encoder stopped. Below the limit it starts
  at once.
- A stop waits at most 3 seconds. ffmpeg gets `SIGKILL` at once. When its exit is still unknown
  after that, the stop returns and the encoder keeps its slot until it exits.
- A yield or a release spends at most 2 seconds keeping the run's init segment, then stops
  without it. The player's next request then starts a new run.
- A new encoder waits at most 10 seconds for the encoders whose places it took. Past that, a
  start fails with capacity reached, and a seek or a resume fails as not ready while the session
  stays.
- A guest whose own session already holds a slot fits sooner, so it is seated ahead of older
  waiters that do not fit yet.
- A guest waits up to 20 seconds to start a stream, then fails with capacity reached. A guest
  resuming a stream waits up to 30 seconds, then its segment request fails as not ready and the
  session stays for the player's retry.
- When household streams fill the limit, another household stream is refused at once, a household
  resume ends its session, and guests wait.
- Until the server checks core tickets (phase 4), every stream it serves is a household stream.
- Original media stays read-only to the server.
