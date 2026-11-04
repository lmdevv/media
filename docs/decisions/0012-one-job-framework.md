# 0012. Run all background work through one job framework in the core

- Status: Accepted, 2026-11-03
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
