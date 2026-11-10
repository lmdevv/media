# 0024. Libraries have a kind, their own folders, grants, and one scan kind per domain

- Status: Accepted, 2026-11-04. Amended 2026-11-09 with the movies catalog, and again the same
  day with each movies document's size bound.
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
  refusing a taken name would tell its creator that a private library exists. A name follows the
  device-name rule (ADR 0006): a manager types it, so one that breaks the rule is refused with
  `invalid_args`.
- A library's folders live in `libraryFolders`, one row per folder, and nowhere else. A library has
  1 to 16 folders. A folder is absolute, written down by `normalizeFolder` from
  `@media/contracts/library-folder` as the web app writes it, without `.` or `..` parts or control
  characters, not `/`, at most 1,024 characters, and at most 32 levels deep, since each level costs
  the overlap check one index read. No folder of a library holds another of it.
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
- An admin sees no library they hold no grant on, in `list`, in `get`, or through a refusal, with
  one exception. Pointing a library at folders tells the admin whether some library already covers
  a folder, private ones included. Admins choose folders on the server's own disk, so they can
  already see which folders hold media, and a generic error would not hide it either, because a
  successful create is still distinguishable. Privacy from admins covers a library's name,
  contents, members and counts, not whether its folders are in use.
- `get` shows the folders, and a failed scan's error, which may name them, only to a manager,
  because they are the server's disk layout. It shows a kid no item count and no scan progress,
  because both would count what their restrictions hide.
- `create`, `setFolders`, and `remove` refuse API keys: a leaked key with the `admin` scope could
  otherwise point the server at any folder it can read, and one with `manage` could delete a
  library and everything it lists.

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
- A callback's `check` does not renew the lease; `report` does. A scanner reports at least once a
  lease while it walks, so a cancel reaches it within one lease and its lease never lapses. A
  canceled scan keeps its slot until then (ADR 0012), so two quick folder changes in a row can
  hold both of a domain's slots for that long.

### The scanner-callback contract

- Every domain function the scanner calls goes through `withScanLease(ctx, kind, lease, write)` in
  `core/scans.ts`. It applies the `check` event through `store.applyEvent` (ADR 0012), so a
  canceled job ends on that call and frees its slot and an older attempt answers `lost`. It checks
  that the lease scans a library of the callback's domain, reads the library and its folders, runs
  `write`, and moves the library's count by the rows `write` says it added and removed, in the same
  mutation. `HeldScan.admit` refuses a path outside the folders.
- The counter's name is private to `scans.ts`. A write outside a scan, such as an import, moves
  the count through `withLibraryItems`, and a purge through `purgeStep`.
- A callback takes at most 500 paths. Each path costs one index read, and Convex caps the index
  ranges one transaction reads at 4,096.
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
- The per-domain purge hooks live in one table in `scans.ts`. Movies' hook is `movies/purge:files`;
  music's is the test seam's until the music port.

### No libraries, no workers

`hasLibraries(db, kind)` reads one index entry. The server-facing `core/scans:domains` query answers
it for every domain, one read each; the server runs a domain's worker pool only while it answers
true (phase 4), and a domain's cron returns at once when it answers false. Removing a library
cancels its scan, so no scan of a domain without libraries stays queued.

### Test seam

`core/libraryProbe.ts` holds `probeItems`, a stand-in for music's tracks until the music port: the
scanner callbacks `known`, `upsert`, and `missing`, the purge hook, a seed of tracks written
through `withLibraryItems`, and `open` and `page`, which decide items through `requireItems` as a
track list will. It takes music libraries only; movies keep their own rows (below).
`packages/platform/test/core/libraries/scanner.ts` drives a scan as the server will: claim,
`target`, a walk with `opendir` and `lstat` only, pages of `known`, batches of 500 (movies sends
again what a call's budget left), finish. For a movies library it sends each file as a movie titled by
its path.

### Movies (amended 2026-11-09)

The movies port replaced the movies half of the seam with movies' own rows in
`convex/movies/` (`titles`, `titleGenres`, `seasons`, `episodes`, `people`, `credits`,
`mediaFiles`, `collections`, `collectionItems`).

- The scanner callbacks are `movies/scanner:known`, `upsert`, and `missing`, server functions
  under `withScanLease`. `upsert` takes up to 500 files, each with its title and episode, writes
  the leading ones its budget admits in order, and answers where each landed and how many it
  wrote (`done`). `missing` marks the leading ones of up to 500 paths missing, answering how many it got
  through, and keeps
  their rows, so a title, its episodes, and everyone's history stay until the file returns or its
  folder leaves; `known` lists missing files too, so the scanner writes a returning one again.
- A movies library's item count is its title count: `upsert` reports the titles it inserted as
  `added`, and the purge the titles it deleted as `removed`. Its episode and file totals are two
  more counters, `movies.episodes:<id>` and `movies.files:<id>`, which every write of those rows
  moves in its own mutation (`movies/totals.ts`).
- Every scanner, metadata, and purge mutation spends a per-call work budget (amended 2026-11-09,
  round 2 of #126's review; `movies/budget.ts`). Each step, such as one file, one path, one
  episode, one title's marking, or one child row, is charged its worst case before it runs. The
  charge is index-range operations and writes, with every `get`, query, insert, patch, and delete
  counted as one range, which bounds what Convex counts from above. A step that would pass 3,200
  ranges or 12,000 writes does not start. That leaves headroom under Convex's 4,096 and 16,000
  for the call's fixed work and for an estimate that runs short. The call commits what it did
  and says how far it got: `upsert`, `missing`, and `applyMetadata` answer `done`, the leading
  items they wrote, and the server sends the rest again. A purge page answers the same cursor
  when it stopped partway, even inside one title's children, and goes on from there. The first
  step of a call always runs, and no single step comes near the budget, so every call makes
  progress. A file's worst case is priced from the file and the two titles it may touch, which
  `upsertCost` reads first. Batches stay at 500 files or paths a call as arguments; the budget,
  not the batch, bounds the work.
  - The first cuts sized batches by a fixed per-file worst case: 500, then 80. Both failed on the
    dev stack, at large genre lists and at purge pages of big shows, and a fixed batch had to
    assume the worst file. The budget charges each file what it can cost.
- Genres are kept as old movies kept them (D62): every distinct genre an NFO or a match names,
  in order, with no refusal. The only bound is 256 distinct genres a title, far above any real
  file, and a title with more keeps its first 256 and the batch goes on. It exists so one title's
  worst case, every one of 256 rows replaced, fits one call. Genre rows are read with
  `take(256)`, never collected. Credits stay at 100 a call and episodes at 500.
- `metadataTarget` lists a show's episodes in pages of 1,000 with a cursor the worker follows, so
  a show of any length is listed whole.
- The purge runs in two stages. `files` reads 500 files a page and deletes those no current
  folder keeps (every file once the library is gone), cancelling their thumbnail jobs, as many as
  its budget admits. `titles` then pages the library's titles 10 at a time, by when each was
  added, and deletes each one no file plays any more, with its episodes, seasons, credits, genre
  rows, and collection memberships, as many rows as its budget admits, rereading the same page
  until a title's rows are gone. Once the library is gone and its
  last title went, its episode and file totals go too. `PurgeScope.gone` tells a hook that the
  library's counts are already gone, so it moves none.
- A title the purge has started deleting is out of every scan's and writer's reach, and out of
  every read, list, and total. Before deleting any of its rows, the purge marks it `purging` and
  moves its `matchKey` to `purging:<id>`, which no scanned key can be. In that same mutation it
  takes the title out of the core's title count, and its episodes out of the library's episode
  total by the title's own `episodeCount`; its files are already gone. A title row keeps that
  count in every mutation that inserts one of its episodes. Episodes never move between titles,
  and only the purge deletes them, after the marking. So the marking is one exact subtraction
  however many seasons the show has. Summing seasons' counts at marking time would need a read
  bounded by a season cap, and a show with more seasons than the cap would leave episodes in the
  total. The pages that delete
  its rows later move no counter. Lists and lookups skip a purging title, so the counters always
  equal the live rows. Because the title is marked, so a file that returns, at its old path or at a new folder, builds a new
  title instead of joining one that is half gone. Writers and the item loaders treat it as gone,
  and later pages delete it whether or not a file appeared. A scan and the purge write the same
  index entries, so Convex runs them one after the other: a scan that lands first keeps the title,
  since the purge then finds its file. Paging by `addedAt` keeps the moved key from shifting the
  title within the purge's own pages. This replaces making scans and purges of one library
  exclusive, which would hold a scan back for the whole purge.
- A title, an episode, and a file are item types, and a file is a download kind
  (`packages/commands/src/access.ts`). Each loader reads the row, its title, and the library once,
  and gives the title's facts (ADR 0005). A file a scan marked missing has no download source, so
  a kept copy reads `gone` and `fetch` issues no ticket until a scan finds the file again.
- `movies/probe.ts` seeds rated titles, shows with episodes, and their files without a scan, and
  opens and pages titles through `requireItems`, as the libraryProbe seam does for music. It
  also sets a library's folders without scheduling the purge and runs one purge page at a time,
  so a test can act between pages.

### Movies document sizes (amended 2026-11-09)

The movies reads reserve, before each read, the most its documents can take (ADR 0005), so each
kind of document needs a bound. Convex allows a document up to 1 MiB, and old movies capped no
text, so a title with an absurd overview could make a call reserve far more than it reads.

- The writers keep each document within a bound, as Convex measures it (`getDocumentSize`):
  64 KiB for a title, 16 KiB for an episode, a person, or a collection, and 2 KiB for a credit
  (`movies/fit.ts`). A real title, with an overview of a few kilobytes and 256 genres, is well
  under its bound.
- A document over its bound is fitted, never refused, so no scan, metadata job, person job, or
  edit fails for it. The longest free text is cut to half its length, never below 64
  characters, until it fits: an overview, an admin's overview, a biography, a role, a name. Only
  when no text can shrink do its longest lists (genres, tags, studios, countries,
  recommendations) lose their last entries. Its library, kind, match key, person key, source
  key, ids, literals, and numbers never change, so matching and rescans behave as before.
- The scanner's and metadata job's title writes, episode writes, person and credit writes, and
  collection writes all go through it. A document under its bound is written exactly as before.

## Consequences

- A domain author writes scanner callbacks as `serverMutation`s that call `withScanLease`, a purge
  hook that calls `purgeStep`, and lists that call `requireItems`. The core keeps no file index:
  the domain owns its rows (D01). Server functions are public and guarded by `media-service`
  (ADR 0005).
- A folder overlap is found however many libraries exist. Old movies read every library for it.
- A canceled scan frees its slot and stops writing on its worker's next call, so a folder change
  never leaves two scans writing one library.

## Alternatives rejected

- Folders as an array on the library row. Checking a new folder would read every library, and the
  row would change with every folder edit.
- A visibility field on the library. It would be a second record of what the grants already say.
- Library-specific share commands (`core.libraries.share`). They would pass through to the generic
  grant functions, and each later container would add three more commands.
- A generic Convex function builder for scanner callbacks. A closure inside a plain
  `serverMutation` needs none. (`serverMutation` itself became generic without casts in the
  movies port, ADR 0005; a scanner callback still calls `withScanLease` inside it.)
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

- Claiming folders through links, bind mounts, and case-insensitive or Unicode-normalizing mounts,
  where two spellings name one folder, needs the server's file access: phase 4, with the scanner,
  by folder identity as old music's `claimRoot` did.
- A library whose last manager's account is deleted has no one who can see it. Account deletion
  does not exist yet; the unit that adds it decides who inherits.
- Guest links (p3-guests) must be a capability of their own, not grants on a title, or items would
  need grants of their own.
- A purge after a folder removal pages the whole library. A domain whose libraries hold many
  items can page only the removed folders' path ranges instead.
- A recount of a library's items from the domain's rows, for a count a defect moved wrong.
- Totals of a library's items by kind of item belong to each domain's port. Movies counts titles,
  episodes, and files (above); music's tracks and albums come with its port.
