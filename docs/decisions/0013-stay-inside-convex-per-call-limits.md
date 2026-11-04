# 0013. Keep SQLite and build every list to stay inside Convex's per-call limits

- Status: Accepted, 2026-11-03
- Decisions: D28

## Context

Self-hosted Convex stores data in SQLite by default. One Convex function call may read at most
32,000 documents and write at most 16,000, and one document may hold at most 1 MiB. A household
music library can hold more tracks than one call may read, and a full rescan after the fresh
install (ADR 0002) touches every file.

## Decision

- Keep SQLite, the Convex default.
- The core enforces the per-call limits, 32,000 documents scanned and 16,000 written, in three
  ways:
  - Every list paginates by an index.
  - Totals live in counter tables, not in counts computed by scanning.
  - Scans write in batches.

## Consequences

- No query reads a whole table. A list that needs every row pages through an index.
- A count, such as the number of tracks in a library, is a read of one counter row.
- Every write that changes a counted set also updates its counter.
- Scans and imports run as batched jobs (ADR 0012), each batch inside the write limit.
- Convex also limits the bytes one call reads and writes. A batch sized by document count can
  still exceed them when its rows are large, so batch sizes account for row size too.
- The deploy needs no separate database server.

## Alternatives rejected

- A Postgres backing store for Convex. SQLite is the default and adds no service to the NAS.
- Counting by scanning. A count over more than 32,000 documents fails the call.

## Edge cases settled

- A library larger than 32,000 items still lists, because the list pages by index.
- A rescan of a large library spreads its writes over many calls, never more than 16,000 in one.
- Every document stays under 1 MiB.
