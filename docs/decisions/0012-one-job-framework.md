# 0012. Run all background work through one job framework in the core

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the framework's shape, and 2026-11-09
  with movies' kinds, pools, and the general lease check.
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
- A delayed retry and a pause of a whole kind, which music's lyrics lookups need.
- Deleting finished jobs after a retention period, before trickplay queues thousands of jobs.
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
- `movies.metadata` (`{ titleId, match }`) dedupes on its title and match, so a refresh joins a
  queued refresh but an admin's match is never folded into one. `movies.person` (`{ personId }`)
  and `movies.trickplay` (`{ fileId }`) dedupe on their row, and `server.backup`
  (`{ trigger }`) on the server, so one backup runs at a time. Metadata and person cap at the `movies` pool's 2.
  Trickplay caps at 8 across workers, above the server's `TRICKPLAY_CONCURRENCY`, 1 by default.
  Old movies' `migration` kind stays `probe.import` until the importer port.
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
