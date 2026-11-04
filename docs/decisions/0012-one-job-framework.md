# 0012. Run all background work through one job framework in the core

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the framework's shape.
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
  kind that has a free slot. The claim reads at most `cap` running rows of each kind, so the cap
  is counted from the rows, with no counter to drift. Two claims of one kind read the same rows,
  and Convex runs them one after the other.
- A lease is `{ jobId, attempt }`. Each claim adds one attempt, and a call with an older attempt
  answers `lost`. A lease lasts 5 seconds to 10 minutes, and `report` renews it.
- A lease ends when the lease-release cron releases it, not at the moment it expires. No claim
  takes over a running job, so a late renew before the release has no rival and keeps its work.
- One cron, `release expired job leases`, runs every 10 seconds. It releases at most 200 jobs per
  call and calls itself again when it filled a batch.
- A strike is an attempt that failed with `retry`, or a lease that lapsed without progress. A
  kind's `maxStrikes` strikes fail the job. Progress means appended items or a moved done mark,
  and it resets the strikes, so an item job that restarts on every deploy keeps going. Counts a
  worker reports are for display, because a restarted attempt reports them again.
- Canceling a queued job ends it at once. Canceling a running job marks it, and the job keeps its
  slot until its worker's next call answers `canceled` or its lease lapses. The cap therefore
  still counts a process that may be running.
- Only the lease holder adds items. One `report` appends up to 4,000 items numbered from the
  job's appended count, so a retried append whose first try committed answers `outOfOrder`.
  `report({ through })` marks the items below `through` done and deletes them, up to 4,000 at a
  time. A job with items succeeds only when its items are sealed and all done. A failed or
  canceled job's leftover items are deleted 4,000 per scheduled call.
- A kind's dedupe key makes `enqueue` return the queued or running job with the same key.
- Every lease call answers `canceled`, `lost`, `outOfOrder`, or `unfinished` as a value. It
  throws only on a defect, such as a lease length out of range.
- The server-facing functions use `serverQuery` and `serverMutation` from
  `convex/core/lib/serverFacing.ts`. They build internal functions until the server signs in to
  the core. That unit replaces the two builders with public ones that require the
  `media-service` scope (ADR 0009, ADR 0010).
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

- A domain's reaction to a finished job, such as a scan stamping its library's last scan time.
  The finishing transition schedules an internal mutation that the domain names per kind. That
  list stays out of `kinds.ts`, because `schema.ts` imports `kinds.ts` and must not import
  `convex/_generated`.
- A helper that checks a lease inside a domain function the server calls, such as a scanner
  callback. It runs `holds` from `machine.ts`, the rule every lease call runs.
- A delayed retry and a pause of a whole kind, which music's lyrics lookups need.
- Deleting finished jobs after a retention period, before trickplay queues thousands of jobs.
- Totals of jobs by status, when a screen shows them. `store.applyEvent` is the one place that
  moves a job between statuses, so the counters go there.

Rejected for this shape:

- A lease document per attempt as the record of who holds a slot. It counts a canceled job's
  slot exactly, but adds a table and a write to every claim, renew, and release.
- Claiming a given job id after reading the queue, as old movies does. The cap would need a
  stored count, and workers race for the same id. With 4 workers, old movies made 3 failed
  claims per job.
- A stored running count per kind. Every transition would have to keep it in step with the rows.
