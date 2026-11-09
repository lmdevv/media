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
  start instead, and its stream ends as `capacity-reached`, not as `failed`. Household streams
  leave the limit as it is when guests' slots are not enough.
- A taken slot counts as part of the stream that took it, and so does the slot of a stream that a
  newer one in its session replaces. If the taker leaves before that slot is free, the slot passes
  to whoever took the taker's own slot, and a guest's slot that passes to a household stream
  yields as a taken one does. Failing that, it counts on its own.
- A stream that a newer one in its session replaced starts no encoder. That holds when the newer
  stream took its slot before its encoder started. It also holds when the older stream claims a
  slot after the newer one holds one, as a resume can, and that claim takes nothing.
- An encoder starts only while fewer encoders than the limit run, counting every one not yet
  stopped. Taken and replaced encoders that are still stopping hold back the streams that took
  their slots, so the limit is never exceeded.
- Every ffmpeg run holds its own slot, and the slot frees only once the server knows the process
  exited. A seek or a resume starts a new run in the stream's own place. While the limit is
  reached, that run starts once the stream's previous encoder stopped. Below the limit it starts
  at once.
- A stream's encoder changes one step at a time, on a fiber the stream owns: the first run, a seek
  or a resume that starts a new run, a hardware fallback, a release, and a yield. A request only
  waits for the step it asked for. When the player disconnects mid-seek, the step still finishes,
  and the stream's next request finds it done.
- A segment, init, or seek request answers within 30 seconds, counting its wait for a step already
  in progress, such as one stuck on a hung disk, and the opening of the files it serves. Past that
  it fails as not ready, and the step goes on. A direct play or download request waits at most 30
  seconds for the library's disk before its response starts, then fails as unreadable. Reading the
  body after that has no bound of its own yet. A start answers within one bound
  from its arrival, then fails with capacity reached: the guest line (20 seconds), the keyframe
  scan's timeout, a replaced stream's stop (3 seconds), and its first run (63 seconds, enough for a
  hardware run to fail and its software fallback to start).
- A step that only waits, as a guest's resume does in the line, stops waiting once its request is
  gone, so the stream's next request does not queue behind it.
- No folder is deleted while the server has a file in it open. Every read of a run's files runs to
  its end once it started, since an interrupted read keeps its handle until the system call
  returns. A segment request's files are opened by the stream for that request, and the run keeps
  its folder until the response is sent. An init segment is a few kilobytes, so it is read whole and
  sent as bytes. A run's folder goes once its process exited, its reads ended, and its responses
  were sent. The stream's folder goes after every run's. A seek, yield, or release waits for the
  previous run's process to exit, not for its folder. An init kept while a stream is released has
  reads of its own too: when the stream moves to a new generation, the old kept init goes once
  those reads end, without the move waiting, and a read the move cut answers that the generation
  moved.
- Requests waiting for the same run share one read of its folder at a time, rather than one each
  per poll.
- A start claims its slot only after its disk space check and keyframe scan. A start stuck in
  either holds no slot and takes no guest's place.
- A stop waits at most 3 seconds. ffmpeg gets `SIGKILL` at once. When its exit is still unknown
  after that, the stop returns and the encoder keeps its slot until it exits. The stream's files
  stay until every run it started has exited, including a run a seek was still stopping, and only
  then are they deleted. A replaced stream ends the same way. The server counts runs whose ffmpeg
  has not exited, closed streams' runs included, for an operator to see a stuck one.
  Shutting down closes every stream at once, so it waits at most 3 seconds in all.
- ffmpeg runs in its own process group, so on Linux the server starts every tool through util-linux
  `setpriv --pdeathsig KILL`. The kernel kills the tool when the server dies, even by SIGKILL, so
  a crash leaves nothing to clean up, and the server never kills by process id. The signal
  follows the thread that spawned the tool, which is Node's main thread and lives as long as the
  server. The image ships `setpriv`, and the NixOS module puts util-linux on the service's path.
  Its system call filter allows `capset`, which `setpriv` calls to re-apply the process's
  capabilities; the unit has none, so this grants nothing. The module also keeps systemd's
  default control-group kill. Checking a recorded process id and
  then signalling it was rejected: the id can be reused between the check and the signal.
- A yield or a release spends at most 2 seconds keeping the run's init segment, then stops
  without it. The player's next request then starts a new run.
- A new encoder waits at most 10 seconds for the encoders whose places it took. Past that, a
  start fails with capacity reached, and a seek or a resume fails as not ready while the session
  stays.
- A guest whose own session already holds a slot fits sooner, so it is seated ahead of older
  waiters that do not fit yet.
- A guest waits up to 20 seconds to start a stream, then fails with capacity reached. A guest
  resuming a stream waits up to 30 seconds, and no longer than its request does. Then its segment
  request fails as not ready, and the session stays for the player's retry.
- When household streams fill the limit, another household stream is refused at once, a household
  resume ends its session, and guests wait.
- Until the server checks core tickets (phase 4), every stream it serves is a household stream.
- Original media stays read-only to the server.
