# 0024. Libraries have a kind, their own folders, grants, and one scan kind per domain

- Status: Accepted, 2026-11-04
- Decisions: D01, D02, D16, D17, D28, D29, D50

## Context

A library is the first real thing the core shares. Both old products had one, and they differed.
Old movies let an admin make a library with an access field (`everyone` or `restricted`), showed
every library to admins, and checked a new folder against every library's folders, naming the
library it overlapped. Old music had an owner and a visibility (`shared`, `restricted`, `private`),
and the media service claimed each folder before a scan to catch links and bind mounts.

The core already decides access in one place (ADR 0005), runs background work as jobs (ADR 0012),
and stays inside Convex's per-call limits (ADR 0013). Phase 3 has no scanner and no domain rows:
the server keeps its file access until phase 4 (D50).

## Decision

### Rows

- A `libraries` row holds a name, a `kind`, and `lastScan`. The kind is the content domain (`movies`
  or `music`), so a later product adds a domain and with it a kind. Names are not unique, because
  refusing a taken name would tell its creator that a private library exists.
- A library's folders live in `libraryFolders`, one row per folder, and nowhere else. A library has
  1 to 16 folders. A folder is absolute, written down by `normalizeFolder` from
  `@media/contracts/library-folder` as the web app writes it, without `.` or `..` parts or control
  characters, not `/`, and at most 1,024 characters. No folder of a library holds another of it.
- No two libraries share files, whatever their kinds. A new folder is refused with `conflict` when
  another library has it, a folder that holds it, or a folder inside it. The check reads one
  `by_path` entry per segment of the folder and one range of at most 17 entries, so it covers
  private libraries without reading every library. The refusal names only the folder the caller
  typed: "Another library already uses /srv/films, a folder that holds it, or one inside it". It
  tells an admin that some library covers the folder, which two libraries can never both do, and
  nothing else. Two claims of overlapping folders read each other's keys, so Convex runs them one
  after the other.
- `lastScan` points at the newest scan job made for the library. That job's status, progress, and
  end are the library's scan state, so no hook stamps the row when a scan finishes. It replaces the
  per-kind finish reaction ADR 0012 left open, for scans.
- A library's item count is one counter (`libraryItems:<id>`, up to 16 shards, ADR 0013).

### Access

- A library is shared only through grants, to a person, a group, or the household (ADR 0005). It
  starts private: the admin who makes it is its first manager. `create` has no sharing argument, so
  there is one way to share.
- Making a library and changing its folders point the server at its own disk, so both need the
  `admin` scope through the server action `manageFolders` in `can()`. Changing folders also needs
  `manage` on the library, checked first, so someone with no grant gets `not_found` whatever their
  role. Renaming, sharing, and removing need `manage`; scanning needs `edit`; reading needs `view`.
  Each also needs the library's domain scope, such as `music:edit`.
- An admin sees no library they hold no grant on, in `list`, in `get`, or through a refusal.
- `get` shows the folders only to a manager, because they are the server's disk layout.

### Commands

`core.libraries.create`, `list`, `get`, `rename`, `setFolders`, `scan`, and `remove`, and the
generic grant commands `core.permissions.grants.set`, `remove`, and `list` (ADR 0005).

### Scans

- `movies.scan` and `music.scan` are reported jobs with payload `{ libraryId }`, cap 2, 3 strikes,
  and one active scan per library through the dedupe key. A scan's durable progress is the domain's
  own rows, which let a restarted attempt skip unchanged files, so a scan's paths never become job
  items.
- `scanKindOf(kind)` in `kinds.ts` is the one place a library kind names its scan kind, and it does
  not compile while a domain lacks one. `core/libraries.ts` is the only code that queues a scan, so
  a music library queues only `music.scan`.
- `scan` joins a scan already queued or running. `setFolders` keeps a queued scan, which reads the
  folders when it starts, and restarts a running one: it cancels it and queues a new one in the
  same mutation.
- The scanner's first call after a claim is `core/scans:target`, which answers the folders under
  the lease.

### The scanner-callback contract

- Every domain function the scanner calls goes through `withScanLease(ctx, kind, lease, write)` in
  `core/scans.ts`. It applies the `check` event through `store.applyEvent` (ADR 0012), so a
  canceled job ends on that call and frees its slot and an older attempt answers `lost`. It checks
  that the lease scans a library of the callback's domain, reads the library and its folders, runs
  `write`, and moves the library's count by the rows `write` says it added and removed, in the same
  mutation. `HeldScan.admit` refuses a path outside the folders.
- The counter's name is private to `scans.ts`. A write outside a scan, such as an import, moves
  the count through `withLibraryItems`, and a purge through `purgeStep`.
- A count stays equal to the domain's rows: it moves in the transaction that writes them, a retried
  call finds its rows and reports nothing new, and two attempts writing one path serialize on its
  index entry.

### Dedupe and cancel

ADR 0012 drops a running job's dedupe key when it is canceled, so a new scan of the same library can
start before the canceled worker's next call. Scans keep that and cap 2. The overlap is safe
because every scanner write is fenced by `withScanLease`: the cancel commits before the new scan is
queued, so each write of the old attempt lands before the cancel, where it is legitimate, or after
it, where it answers `canceled` and writes nothing. The two attempts may both read the disk; they
never both write.

### Folders and removal

- Removing a folder schedules the domain's purge, which deletes 500 rows a page that no current
  folder holds and moves the count in the same mutation. It reads the folders again on each page,
  so a folder added back keeps its rows. A scan's `known` page lists only rows inside the current
  folders, so a running scan never reports a purged folder's rows missing.
- Removing a library cancels `lastScan`, frees its folders, deletes its counter and its grants (at
  most 1,000), deletes the row, and schedules the purge, all in one mutation of about 1,050 reads
  and writes. Its items vanish with its grants, because an item's level is its library's. A kid's
  allowed-libraries list may keep the removed id, which matches nothing.
- The per-domain purge hooks live in one table in `scans.ts`. Until the movies port, both domains'
  hooks are the test seam's.

### No libraries, no workers

`hasLibraries(db, kind)` reads one index entry. The server-facing `core/scans:domains` query answers
it for every domain, one read each; the server runs a domain's worker pool only while it answers
true (phase 4), and a domain's cron returns at once when it answers false. Removing a library
cancels its scan, so no scan of a domain without libraries stays queued.

### Test seam

`core/libraryProbe.ts` holds `probeItems`, a stand-in for a domain's rows: the scanner callbacks
`known`, `upsert`, and `missing`, the purge hook, a seed of rated items written through
`withLibraryItems`, and `open` and `page`, which decide items through `requireItems` as a title
list will. `packages/platform/test/core/libraries/scanner.ts` drives a scan as the server will:
claim, `target`, a walk with `opendir` and `lstat` only, pages of `known`, batches of 500, finish.
The movies port replaces the seam with movies' rows and deletes it.

## Consequences

- A domain author writes scanner callbacks as `serverMutation`s that call `withScanLease`, a purge
  hook that calls `purgeStep`, and lists that call `requireItems`. The core keeps no file index:
  the domain owns its rows (D01).
- A folder overlap is found however many libraries exist. Old movies read every library for it.
- A canceled scan frees its slot and stops writing on its worker's next call, so a folder change
  never leaves two scans writing one library.

## Alternatives rejected

- Folders as an array on the library row. Checking a new folder would read every library, and the
  row would change with every folder edit.
- A visibility field on the library. It would be a second record of what the grants already say.
- Library-specific share commands (`core.libraries.share`). They would pass through to the generic
  grant functions, and each later container would add three more commands.
- A generic Convex function builder for scanner callbacks. Typing a builder over arbitrary argument
  validators needs casts; a closure inside a plain `serverMutation` needs none.
- Scan paths as job items. A 40,000-file scan would write 40,000 items and delete them again, and
  finding missing files still needs every known row of the library.
- Cap 1 per scan kind, or keeping the dedupe key until the cancel ends. Cap 1 makes a small
  library wait behind a large one's scan. A kept key hands a folder change the stale scan.

## Edge cases settled

- A folder inside another library's folder is refused across kinds: a grant on a music library
  inside a movies library would show the movies library's files.
- A member granted `manage` may rename, share, and remove a library an admin made, but cannot
  change its folders.
- The last manager of a library cannot leave or be lowered (ADR 0005), so a library always has one
  while its manager's account exists.

## Left for later units

- Claiming folders through links and bind mounts, as old music's `claimRoot` did, needs the
  server's file access: phase 4, with the scanner.
- A library whose last manager's account is deleted has no one who can see it. Account deletion
  does not exist yet; the unit that adds it decides who inherits.
- Guest links (p3-guests) must be a capability of their own, not grants on a title, or items would
  need grants of their own.
- Totals of a library's items by kind of item (titles, episodes, tracks, albums) belong to each
  domain's port.
