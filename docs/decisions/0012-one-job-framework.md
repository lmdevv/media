# 0012. Run all background work through one job framework in the core

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the framework's shape, and 2026-11-09
  with movies' kinds, pools, and the general lease check. Amended 2026-11-10 with the sweep of
  finished jobs, and again the same day with the Jellyfin and Plex import kinds. Amended
  2026-11-14 with a kind's pause and hold, the delayed retry, and music's lyrics lookups.
- Decisions: D27

## Context

Both repos have a `jobs` table with leases, and they differ in detail. Movies' statuses are
`pending`, `running`, `succeeded`, `failed`, and `cancelled`. Music's are the same except that a
finished job is `done`. Both have a `maintenance.releaseExpiredLeases` function
with different contracts, and both register a cron under the same name. Music runs lyrics lookups
through its own queue.

Both repos also have a table called `migrations`, for different things. In movies it holds
Jellyfin and Plex import jobs. In music it holds cursors for its data-migration runner.

## Decision

- One core job framework runs every background task. A job has:
  - a kind and a typed payload,
  - a lease that its worker renews,
  - an attempt count,
  - a per-kind concurrency cap,
  - batched items.
- Job statuses are `queued`, `running`, `succeeded`, `failed`, and `canceled`.
- One cron releases expired leases.
- Music's lyrics queue becomes a job kind.
- Music's cursor-based data-migration runner becomes the core `schemaMigrations`.
- Movies' Jellyfin and Plex import records become `imports`.

## Consequences

- A scan, a trickplay job, a lyrics lookup, and an import all report state through the same
  statuses.
- Per-kind caps keep one kind from filling the queue. The server's worker pools cap them again by
  domain (ADR 0014).
- A later product adds job kinds, not a new queue (ADR 0002).
- The name `migrations` goes away, so schema migrations and media-server imports no longer share
  a word.

## Alternatives rejected

- One queue per domain or per feature, such as music's lyrics queue. One framework replaces them.
- The old status names `pending`, `done`, and `cancelled`. The framework uses `queued`,
  `succeeded`, and `canceled`, and the fresh install (ADR 0002) means no stored job needs
  renaming.

## Edge cases settled

- A finished job is `succeeded` in every domain, never `done`. A waiting job is `queued`, never
  `pending`. A stopped job is `canceled` with one `l`.
- One cron releases expired leases for every kind. Domains do not register their own.
- Lyrics lookups are jobs with their own kind and cap.
- A large job writes its items in batches, inside Convex's per-call limits (ADR 0013).

## Shape (amended 2026-11-04)

The first framework, in `packages/platform/convex/core/jobs/`, settled how these parts fit.

- `KINDS` in `kinds.ts` is the one list of kinds. An entry names the kind, its payload validator,
  its item validator or none, its cap, its `maxStrikes`, and its dedupe key. The stored payload
  and item validators derive from the list, so a new kind is one entry. A kind name carries its
  domain, such as `movies.scan`. The `probe.*` kinds ship for the stack suite, like
  `limitsProbe`, and the server never claims them.
- A job row is one union over its five statuses, so only a running job carries a lease. One pure
  function, `step` in `machine.ts`, makes every transition, and `store.ts` is the only code that
  writes `jobs` and `jobItems`. Unit tests cover the transitions without a backend.
- A worker claims by kind: `claim({ kinds, workerId, leaseMs })` takes the oldest queued job of a
  kind that has a free slot. A `jobKinds` row per kind holds its running count and the creation
  time that no queued job of the kind is older than. `store.ts` moves the row in the same
  mutation as every job transition and enqueue, so a claim reads one row and one queue entry.
  Every claim and every job that stops running writes the row, so Convex runs them one after the
  other, and the cap holds under any number of workers.
- A lease is `{ jobId, attempt }`. Each claim adds one attempt, and a call with an older attempt
  answers `lost`. A lease lasts 5 seconds to 10 minutes, and `report` renews it.
- A lease ends when the lease-release cron releases it, not at the moment it expires. No claim
  takes over a running job, so a late renew before the release has no rival and keeps its work.
- One cron, `release expired job leases`, runs every 10 seconds. It releases at most 200 jobs per
  call and calls itself again when it filled a batch.
- A strike is an attempt that failed with `retry`, or a lease that lapsed without progress. A
  kind's `maxStrikes` strikes fail the job. Progress means appended items or a moved done mark.
  The report that records progress resets the strikes, so an item job that restarts on every
  deploy keeps going, and a failure after progress counts as the first strike. Counts a worker
  reports are for display, because a restarted attempt reports them again.
- Canceling a queued job ends it at once. Canceling a running job marks it, and the job keeps its
  slot until its worker's next call answers `canceled` or its lease lapses. The cap therefore
  still counts a process that may be running. The marked job drops its dedupe key, so a new job
  with that key can be queued right away.
- Every lease call is a mutation that runs `step`: `report`, `finish`, and `items`, which runs the
  `check` event. The call that answers `canceled` therefore ends the job and frees its slot.
  `items` was first a query. It answered `canceled` but could not write, so the worker stopped and
  the slot stayed taken until the lease lapsed, up to 10 minutes later. A stack test catches it.
  The fencing rule, `holds`, is private to `machine.ts`, so only `step` decides a lease.
- Only the lease holder adds items. One `report` appends up to 4,000 items numbered from the
  job's appended count, so a retried append whose first try committed answers `outOfOrder`.
  `report({ through })` marks the items below `through` done and deletes them, up to 4,000 at a
  time. A job with items succeeds only when its items are sealed and all done. A failed or
  canceled job's leftover items are deleted 4,000 per scheduled call.
- A kind's dedupe key makes `enqueue` return the queued or running job with the same key. The
  stored key starts with the kind's name, so two kinds never share one.
- Calls that move jobs in one mutation run one after another, because each one reads and writes
  its kind's `jobKinds` row. Run in parallel, two releases of one kind both read the same count
  and one decrement was lost, which a stack test caught.
- Every lease call answers `canceled`, `lost`, `outOfOrder`, or `unfinished` as a value. It
  throws only on a defect, such as a lease length out of range.
- The server-facing functions use `serverQuery` and `serverMutation` from
  `convex/core/lib/serverFacing.ts`. Since the movies port they build public functions that
  require the `media-service` scope (ADR 0005, ADR 0009, ADR 0010).
- `schemaMigrations.ts` is music's runner with one list, `MIGRATIONS`. `run` starts each
  unfinished migration from its saved cursor, and a step runs only from the saved cursor, so two
  chains never both advance. A changed migration needs a new name, because a deployment that
  finished the old name never runs it again. `scripts/dev-stack.sh` calls `run` after it deploys the core, and
  the deploy image does the same once the server joins it.
- An `imports` row holds the source, the server id and name, and the job. One active import per
  source server is the import kind's dedupe key. Movies keeps the import plan, its resume point,
  and the imported counts in its own table, keyed by the import id.

Measured on this repo's dev stack:

- Claims of one kind can still fail with `OptimisticConcurrencyControlFailure` after Convex's own
  retries. Eight workers on two kinds hit it. A worker retries a refused claim.
- A deployment writes at most about 4 MiB per second, and an append of 4,000 small items writes
  about 1.08 MB. A worker paces large appends and retries the `TooManyWrites` refusal.

Left for the first unit that needs each one:

- A domain's reaction to a finished job. Scans need none: a library points at its newest scan
  job, whose status is the library's scan state (ADR 0024). A kind that must react schedules an
  internal mutation that the domain names per kind, in a list outside `kinds.ts`, because
  `schema.ts` imports `kinds.ts` and must not import `convex/_generated`.
- A delayed retry and a pause of a whole kind, which music's lyrics lookups need (settled by
  p5-lyrics, below).
- A command that recounts a kind's `jobKinds` row from its running jobs, for an operator who
  edited jobs by hand. Every write in this unit goes through `store.ts`, so nothing else moves
  the count.
- Totals of jobs by status, when a screen shows them. `store.applyEvent` is the one place that
  moves a job between statuses, so the counters go there.

Settled by the movies catalog (2026-11-09):

- Each kind names its server pool (ADR 0014) in `KINDS`: `movies.scan`, `movies.metadata`, and
  `movies.person` run in `movies`, `movies.trickplay` in `movies.background`, `music.scan` in
  `music`, and `server.backup` in `server`. The `probe.*` kinds name `probe`, which no server pool
  claims. A kind's cap bounds it across every worker; the pool's cap bounds its kinds on one
  server.
- A movies job's dedupe key names the revision of what it works from, not just the row
  (amended 2026-11-09, Codex review of #126). `movies.metadata` (`{ titleId, match, revision }`)
  dedupes on the title, the title's `updatedAt` when asked, and the match. `movies.person`
  (`{ personId, revision }`) dedupes on the person and their `updatedAt`. `movies.trickplay`
  (`{ fileId, revision }`) dedupes on the file and its contents, `size:mtime`. A request for a row
  that changed since a job read it gets a job of its own, even while the old one runs, and an
  admin's match never folds into a refresh. `recordTrickplay` records only for the job the file
  waits on and the contents it has; a late result for older contents changes nothing.
- A title's `matchGeneration` moves when an admin's match is asked for, never when one applies
  (amended twice on 2026-11-09). `askForMatch` in `movies/matching.ts` moves it and queues the
  manual job carrying the new generation; `askForRefresh` queues a refresh at the current one.
  A `movies.metadata` job carries its generation in its payload and dedupe key. Every write of
  the newest job is therefore current: its continuation calls, its credits, and its collection.
  A refresh or an earlier match asked for before it is stale: `applyMetadata` answers
  `applied: false` with `done: 0`, and the worker stops that job instead of sending the rest
  again. `applyCredits` and `applyCollection` write nothing for a stale job.
  `applyMetadata` only marks the title manual for a manual job and never moves the generation.
  The first cut moved the generation when the match applied, which dropped the manual job's own
  continuation calls and its later credits as stale.
- Scans are not fenced on the generation. Scans skip a manual title (D62), so once a match
  applies none writes it again. Before it applies, the manual job rewrites the title's metadata,
  credits, and collection after whatever a scan wrote.
- `withJobLease(ctx, kinds, lease, write)` in `jobs/held.ts` is the lease check of every server
  function that writes for a job. It applies the `check` event as `items` does, narrows the
  payload to the kinds it accepts, and throws on a lease of another kind, a server defect.
  `withScanLease` is its scan form. A movies writer accepts exactly the kinds that may write its
  rows: credits and a collection under the title's metadata job or a scan of its library, a
  person's details under their person job or a metadata job of a title that credits them, and
  thumbnails under the file's trickplay job.
- Scrub thumbnails need no reaction to a finished job. A file's `trickplay` state names its job,
  and a scan that finds the job failed for the file's current contents counts it as their
  failure, as old movies' `settleTrickplay` recorded it, so it does not queue them again.
- Finished trickplay jobs are not yet deleted after a retention period. A first scan of a large
  library now queues a job per video file, so that unit is due before cutover.

Settled by the libraries build (ADR 0024):

- The lease check inside a domain function the server calls is `withScanLease` in
  `convex/core/scans.ts`. It applies the `check` event through `store.applyEvent` in the
  callback's mutation, as `items` does, so a cancel it reports also ends the job.
- Scan kinds keep the dropped dedupe key and cap 2. A library's new scan may start while its
  canceled scan's worker has not yet called again, and the old attempt writes nothing after the
  cancel, because every scanner write runs `withScanLease` first.
- Job writes take `JobCtx`, the database and the scheduler, so a command handler, whose context
  has no `auth`, can queue and cancel jobs.
- People cancel through each domain's own command, never the internal `core/jobs/admin:cancel`
  (p4-movies-parity): `core.libraries.cancelScan` for a scan, with `edit` on its library through
  `can()`, and `movies.imports.cancel` for an import, for owners and admins. Each names the job
  (the scan's job id, the import's row), never "the library's current scan", so a cancel that
  arrives after its job finished and another started changes nothing and answers how the named
  job ended. Each also names the attempt the person saw (the job's `attempts`, which the scan and
  import views show), and the machine's `cancel` event carries it: when the job was claimed again
  since, as after a lapsed lease, the cancel changes nothing and answers `movedOn`, so a cancel
  meant for an attempt that died never stops the one that replaced it. The core's own cancels (a
  removed library's scan, a probe kind's jobs, a stale trickplay) pass no attempt and stop
  whichever holds the job; `core/jobs/admin:cancel` takes an optional one. The machine fences the
  rest: a running job's next lease call answers `canceled`, and that attempt's later reports and
  finish are refused, so no late report undoes a cancel.
- `core.server.backups.active` answers the backup job queued or running, so the Backups screen
  keeps Back up now off for the whole job rather than only while `run` is in flight.

Rejected for this shape:

- A lease document per attempt as the record of who holds a slot. It counts a canceled job's
  slot exactly, but adds a table and a write to every claim, renew, and release.
- A separate call that acknowledges a cancel. A worker that stops without making it holds the
  slot until its lease lapses, and the protocol gains a sixth call.
- `items` answering `held` while a cancel waits, so that only `report` and `finish` answer
  `canceled`. The worker would process another page of a canceled job.
- Claiming a given job id after reading the queue, as old movies does. The cap would need a
  stored count, and workers race for the same id. With 4 workers, old movies made 3 failed
  claims per job.
- Counting the running rows on every claim, with no stored count. A range of `jobs` that a busy
  queue moved through keeps the index entries of every job that left it until Convex's retention
  removes them, and a claim scans them all. After 5,000 jobs of one kind, an idle claim took 10 ms
  against 2 ms, and 1,000-job runs with 4 workers slowed from 31 s to between 72 s and 81 s.

## Finished jobs (amended 2026-11-10)

A first scan queues one trickplay job per video file, so finished jobs must not pile up forever.

- The hourly cron `delete week-old finished jobs` runs `core/jobs/cleanup:sweep`. It deletes
  succeeded, failed, and canceled jobs that finished more than 7 days ago, of the kinds nothing
  points at: `movies.trickplay`, `movies.metadata`, `movies.person`, `server.backup`,
  `probe.capped`, `probe.wide`, and `probe.items`. Scans stay, because `libraries.lastScan` is a
  library's scan state. Imports stay, because an `imports` row names its job.
- A job keeps at most 4,096 characters of each worker's text: the message of a report or a
  success, and the error of a failure, both as `error` and as a queued retry's `lastError`. The
  machine cuts a longer one, never inside a surrogate pair, and ends it with "… (cut)"; a report or
  finish never fails for length.
- It reads `jobs.by_kind_status_finished` for each kind and status, so it never reads the jobs
  it keeps. One call deletes at most 256 jobs, 4,000 of their items, and 12 MiB of reads, each
  job's items before the job. A job with more items carries on in the next call. Before each read
  it reserves 1 MiB per job it may return, a Convex document's limit, because a job written
  before the text bound may be that large, plus a trickplay job's file at its 16 KiB bound, each
  counted twice because Convex reads a document again to delete or rewrite it. It reads only as
  many jobs as the budget holds, measures each one it read, and deletes them before the next read,
  so a call always deletes the jobs it read and never reads past 16 MiB; the 4 MiB left over holds
  the items it deletes. A call that fills any budget schedules the next one at
  once. Deleted jobs leave the index, so the sweep needs no
  cursor. `store.deleteFinishedJob` does the delete, so `store.ts` stays the only writer of
  `jobs` and `jobItems`. A finished job is neither running nor queued, so `jobKinds` rows stay as
  they are.
- A file's pending trickplay state may name a finished job. A failed job is the failure of the
  contents it was for, and `queueTrickplay` reads it to avoid queuing again. In the mutation that
  deletes such a job, `releaseTrickplayJob` writes that failure into the file. After a canceled or
  succeeded job it drops the file's state, as a gone job already meant. No file then names a
  deleted job.
- The stack suite's `core/jobs/probe:backdate` moves a finished job's end back a week, so a test
  need not wait. It is the one write to `jobs` outside `store.ts`, and only the suite calls it.

## Jellyfin and Plex imports (amended 2026-11-10)

`p4-movies-importer` moved old movies' importer onto the core's imports, beside the old one, which
stays wired until `p4-movies-cutover`.

- `movies.import.jellyfin` and `movies.import.plex` replace `probe.import`. Each takes
  `{ source, serverId }`, runs in the `movies.import` pool (ADR 0014) with cap 1 and 3 strikes, and
  dedupes on the server id, so a second start of a server while its import is queued or running
  answers that one. `core/imports.ts:startImport` queues it; the kind's dedupe decides, and the
  `imports` row and movies' `importPlans` row are written only for a new job, in the same
  mutation.
- A run's row in `imports` names its job for good: the sweep keeps import jobs. `importPlans`
  holds the plan (the source's address, credentials the server sealed under its own key, the
  mapped users, the path mappings, the planned libraries), the libraries the import found or
  added, the checkpoint, and the counts, keyed by the import. It is a movies table written only
  through `movies/write.ts`, within its 896 KiB bound (`IMPORT_BOUNDS`). The server's dry run and
  start refuse a plan past those bounds (200 mapped users, 50 path mappings, 50 libraries, 50
  library folders) before anything is written, and `start` checks them again.
- Each source user maps to a core user, never to a profile (D12). A source user mapped to no one
  is absent from the plan, and a write for a user the plan does not map, or one no longer in the
  household, writes nothing. Progress, history, and the list are each user's own (D36).
- An import adds the libraries it needs, as old movies' importer did (corrected in review, D62):
  the first version added none, which left source folders no library covered unmatched and refused
  an empty install. A run starts in the `libraries` phase. `ensureLibrary` takes the planned
  libraries one a call: a folder another library has, holds, or lies in is covered by it, whose
  sharing stays as it is, and the rest become new movies libraries named after the source library,
  made through `core/libraries.ts:makeLibrary`, the one way a library is made, with the requester
  their first manager and their first scans queued. A library holds at most 16 folders, so a
  source library with more becomes several, "<name>", "<name> 2", and on, shared alike, so every
  folder is claimed and scanned (corrected in review). They are shared through the ordinary grants
  (ADR 0024, not a second sharing path), in one read of the new row's grants
  (`grants.ts:shareNew`), which never lowers the requester's `manage`: with the household when
  every source user could see the source library; otherwise a `view` grant to the core user of
  each mapped source user it let see it and to every current owner and admin, and to the owners
  and admins alone when the source did not say (Plex). Old movies' admins saw every library; the
  core expresses that with per-user grants when the library is added (decided in review), and an
  admin promoted later gets no grant from it. A library is added only on folders the scanner
  itself accepts (`LibraryScanner.openRoot`: the folder's real path lies inside an approved root's
  real path), so a mapped link that leads inside an approved root counts and a folder outside
  every one does not; the items of other folders stay unmatched. The run then waits in the
  `scanning` phase, up to 6 hours an attempt, until the scans of the libraries it found or added
  finish, before it matches history, as old movies did.
- Imports run in their own `movies.import` pool (cap 1 on a server, ADR 0014), which claims whether
  or not movies has a library: the `movies` pool claims only once one exists, and on an empty
  install the import is what adds the first.
- Starting needs what pointing a library at folders needs: `manageFolders` in `can()`, which an
  owner or an admin holds, because the path mappings point the server at folders on its own disk.
  The server's flow (`apps/media/src/migration/core-imports.ts`) asks `mayImport` before it
  connects, and `start` checks again with the user the flow names. Connect, dry run, and start stay
  the server's: only it reaches the source and its disk, and the source's credentials never reach
  the core unsealed. `movies.imports.list` and `get` are commands for reading runs, `movies:edit`
  in scope and owners and admins only in `can()`.
- Progress lands as an offline report does: only when the source played the item more recently
  than the core did, or the core has no row, so an import never moves a newer row back, whatever
  playback last reported. Imported progress is older data, so it never invalidates a person's own
  newer word (corrected in review): an import never moves the title's history generation, so the
  scheduled pages of a whole-show mark made during the import still finish over what it wrote, and
  a whole-title mark records when it was made (`watchMarks.markedAt`), so source progress played
  before it is skipped, a watched or an unwatched mark alike. In turn, a mark's pages leave a row
  played after the mark as it is, so a late page of an older whole-show mark never rolls back or
  deletes newer progress an import wrote, or the person's own (corrected in review). The first
  version moved the generation on every write, which cancelled the rest of a whole-show mark made
  while it ran. Watched marks only get set, favorites join the list once, and a play count above 0
  counts an item as played; the core keeps no count.
- Each write (`writeWatchState`, `writeCollections`, `writeEdits`) charges every item's worst case
  against the call's ranges, writes, and bytes (`movies/budget.ts`, `movies/reads.ts`), writes the
  leading items that fit, and moves the checkpoint past them in the same mutation. The server
  sends the rest again. A call carries the checkpoint it starts from; one whose checkpoint is not
  the stored one, such as a call sent again after it committed, or an older attempt's, writes
  nothing and answers the stored checkpoint. A restarted run therefore goes on from exactly where
  the last one stopped and writes nothing twice. A write that sends the last items of a user or a
  phase names where the next items start (`continueAt`), and the core moves there in the same
  mutation, so an empty user or phase costs no call; `advance` moves the checkpoint only past
  items there were none of to send.
- The checkpoint indexes the plan a run computes, as old movies' did: the planned library, the
  user, the item within the user's matched items in source item order, the collection, or the
  title. A restarted attempt computes the plan again, so a source or catalog that changed between
  attempts can shift those positions and skip or resend items near the checkpoint. Every write is
  safe to repeat, so a resent item writes nothing twice. Keying the checkpoint on source item ids
  would close the gap; it is not old movies' behavior (D62) and is left for the backlog.
- A source collection keeps its first 1,000 matched members, as old movies kept them. A collection
  longer than one call's budget continues from its member index.
- A source failure fails the run with the line the connect form shows for it (`failureLine`), so a
  key the source refuses fails with the token field's line. Only an unreachable source retries.

## Music's lyrics lookups (amended 2026-11-14)

`p5-lyrics` moved old music's LRCLIB lookups onto the framework. Old music kept them in its own
`lyricLookups` queue, with a priority, a lease, tries, and a wait after a failed try, and a
one-row `lrclibPause` table that hid the queue while LRCLIB was unavailable.

- `music.lyrics` takes `{ trackId, revision, query }`: the revision is SHA-256 of old music's
  lookup key (`@media/contracts/lyrics-lookup`: artist, title, and album normalized, and whole
  seconds), and the query the tags LRCLIB is asked with. It runs in the `music.background` pool
  with cap 1 and 5 strikes, old music's five tries, and dedupes on the track and the revision, so
  a retagged track gets a lookup of its own and the same tags never get two. The server's pool
  claims only `music.lyrics`, so a backfill never takes music's scan slot and its claims never
  read the scan queue (ADR 0014).
- A kind can be paused. A worker finishes an attempt `deferred` with `pauseMs`: the job goes back
  to the queue with no strike, and the store sets the kind's `jobKinds.pausedUntil`, keeping a
  later one, and schedules `leases.endPause` at that time. While paused, `kindQueue` offers no job
  and `waiting` answers not ready; ending the pause writes the row, which wakes the pools that
  subscribe to it. This is old music's `lrclibPause`, kept as job state, so it holds across a
  restart.
- A retry can wait. A worker's failed finish may carry `retryInMs`; the queued job then carries
  `waitUntil`, and the claim reads `by_kind_ready`, whose range takes only jobs without one, so a
  waiting job never blocks the jobs behind it and costs a claim nothing. `leases.wake`, scheduled
  for that time and fenced on the attempt, clears it and moves the kind's `queueFrom` back to the
  job's creation, so the job keeps its place. Old music waited 1, 5, and 30 minutes and 2 hours
  after a try whose record could not be read; the lookup does the same.
- A kind can be held. `holdKind` sets `jobKinds.held`, and no claim takes the kind's jobs, which
  stay queued; a running one finishes. Music holds `music.lyrics` while an admin has turned
  LRCLIB lookups off (`music.lyrics.configure`, old music's `remoteLyrics`), so with the switch
  off no request reaches LRCLIB; turned on again, the queued lookups run, as old music's did.
- The cron `wake waiting job retries and end job pauses` runs `leases.wakeDue` every minute. It
  wakes due retries and ends due pauses whose scheduled call never ran, as after a restore from a
  backup, reading only rows whose time passed (`jobs.by_status_wait`, `jobKinds.by_paused`).
- A lookup's answer and its job's end commit together. `music/lyricLookups:settle` checks the
  lease, stores what LRCLIB answered in `lrclibLyrics` through the music store, which bounds a row
  at 512 KiB and charges the bytes and the sets it walks (#152), and applies the job's finish in
  the same mutation. A server stopped before that call leaves the job to run again; one stopped
  after it never asks LRCLIB for that song again, and a request for a song with a standing answer
  (found, instrumental, or a miss younger than 30 days) for its current revision queues nothing.
  The server's pool learns of that end from the handler (`CoreJobs.Settled`) and calls `finish`
  no more.
- Lookups are asked for where old music asked for them: when a song starts playing
  (`music.play.start`), when it is downloaded (`core.downloads.add`), and by an admin's
  `music.lyrics.backfill`. Each is a scheduled `requestTracks` or `backfill`, never part of the
  person's own call, so an enqueue never conflicts with it. A scan asks for none, as in old music.
- A backfill queues a library's tracks a page of 50 at a time, and only while fewer than 25
  lookups wait; otherwise it looks again after 2 seconds, doubling to a minute. A backfill over a
  library of any size therefore keeps at most a page ahead of the worker, makes no run of mass
  inserts on the kind's row (the OCC lesson of #134), and a song that starts playing waits behind
  at most that many lookups.

Where it differs from old music (D62):

- No priorities. Old music took a playing song's lookup before a download's, and a download's
  before a backfill's, newest playing song first. The framework claims a kind's jobs oldest first;
  the backfill's short queue bounds how long a playing song waits instead.
- A song's lookup is asked for when it starts, not also when it becomes the song up next.
- One lookup per track and revision, where old music shared one lookup between songs whose tags
  normalized alike; two copies of a song are looked up once each.
- A lease that lapses five times in a row fails the job without storing a miss, so a later request
  queues the song again; old music stored a miss for 30 days.
- LRCLIB's lyrics that do not fit the 512 KiB row keep their leading sets, as a song's own do;
  old music stored none past 800 KiB and called the song a miss.
