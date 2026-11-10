# 0024. Libraries have a kind, their own folders, grants, and one scan kind per domain

- Status: Accepted, 2026-11-04. Amended 2026-11-09 with the movies catalog, and again the same
  day with each movies document's size bound. Amended 2026-11-10 with folder identity, and again
  the same day with rescans after a file changes.
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

- **One writer.** Every insert, patch, and replace of a movies table goes through
  `movies/write.ts`: the scanner, metadata, credits, person, collection, edit, match, purge,
  thumbnail, playback, history, and the stack probe's seeds. A patch of a title, a season, an
  episode, a person, a collection, or a media file is merged with the stored document and fitted
  as a whole, so a merge can never grow a document past its bound. The `media/movies-writer`
  Oxlint rule (`tools/oxlint/media/`, with its own tests) fails any other write. In
  `convex/movies/` it fails every write but an insert into a core table, and elsewhere any write
  that names a movies table. It follows a database through `ctx.db`, `ctx["db"]`, and any name it
  is given (`const store = ctx.db`, `{ db: store }`), and fails a write method taken off one
  without a call (`const { insert } = ctx.db`, `ctx.db.patch.bind`) or called through a computed
  name.
- **Every table has a bound, a fitter, and a read reservation.** `TABLE_BYTES` in `movies/fit.ts`
  is typed over the schema's tables, so a table added without a bound does not compile, and a
  unit test builds one document per table:

  | Table                                     | Bound  | Fitter                                                               | Reads reserve                                                                                                                                        |
  | ----------------------------------------- | ------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `titles`                                  | 64 KiB | `fitTitle`                                                           | the bound per title read (`TITLE_GET`, `titlesOf`)                                                                                                   |
  | `episodes`                                | 16 KiB | `fitEpisode`                                                         | the bound per episode read (`EPISODE_GET`, `episodesOf`)                                                                                             |
  | `people`                                  | 16 KiB | `fitPerson`                                                          | the bound per person read (`peopleOf`)                                                                                                               |
  | `collections`                             | 16 KiB | `fitCollection`                                                      | the bound per collection read (`collectionsOf`)                                                                                                      |
  | `mediaFiles`                              | 16 KiB | `fitMediaFile`                                                       | pages sized by the bound: `scanner.known` reads 768 files (12 MiB), a title's or episode's files at most 100 (1.6 MiB), the purge 500 a page (8 MiB) |
  | `seasons`                                 | 4 KiB  | `fitSeason`                                                          | a title's detail reads at most 200 (800 KiB), the purge 200 at a time                                                                                |
  | `credits`                                 | 2 KiB  | `fitCredit`                                                          | the bound per credit row (`creditRowsOf`)                                                                                                            |
  | `titleGenres`                             | 1 KiB  | `fitGenreRow`                                                        | 1 KiB per row, as small rows                                                                                                                         |
  | `watchProgress`                           | 1 KiB  | `fitProgress` (its playback id)                                      | 1 KiB per row, as small rows                                                                                                                         |
  | `collectionItems`, `myList`, `watchMarks` | 1 KiB  | none needed: every field is an id, a number, a boolean, or a literal | 1 KiB per row, as small rows                                                                                                                         |

  A real document is well under its bound: a title with an overview of a few kilobytes and 256
  genres, a file with dozens of tracks and chapters.

- **Fitted, never refused.** A document over its bound is fitted, so no scan, metadata job,
  person job, or edit fails for it. Every long free text is cut to half its length, never below
  64 characters, the longest field first, until it fits: an overview, an admin's overview, a
  biography, a role, a name, an artwork key, each genre, tag, studio, and country, and a media
  file's chapter titles, track names, languages, codec names, container, and version name. Only
  when no text can shrink do its longest lists lose their later half: a title's genres, tags,
  studios, countries, and recommendations, and a file's chapters, subtitle tracks, subtitle
  files, audio tracks, and video tracks. Each step halves something, so any document fits in a
  few dozen steps. Its library, kind, identity fields, path, literals, and numbers never change,
  so matching and rescans behave as before. A document under its bound is written exactly as
  before.
- **Identity bounds.** Identity fields are bounded where the server functions take them
  (`movies/bounds.ts`: the scanner's upsert and missing calls, `applyMetadata`, `applyCredits`,
  `applyCollection`, `applyPerson`, and the match command), and the fitters apply the same bounds
  again:

  | Field                                                                       | Maximum                          | Over it                                                                |
  | --------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
  | TMDB, IMDb, and TVDB ids; a recommendation; a trailer's video key           | 256 characters                   | stored as null (a recommendation is dropped, a trailer removed)        |
  | A title's match key, a person's key and name key, a collection's source key | 512 characters                   | first 447 characters, `#`, and the key's hex SHA-256                   |
  | A credits, collection, or companion digest; a thumbnail manifest's version  | 128 characters                   | first 63 characters, `#`, and the digest's hex SHA-256                 |
  | A genre                                                                     | 64 characters                    | not kept                                                               |
  | A title genre row's copy of its title's sort key                            | 128 characters                   | cut to 128 (it only orders rows)                                       |
  | A file's path                                                               | 4,096 bytes (Linux's `PATH_MAX`) | the file is skipped and counts as done                                 |
  | A subtitle file's name                                                      | 255 bytes (Linux's `NAME_MAX`)   | that subtitle file is left out                                         |
  | A title's, a collection's, or a credit's tie                                | a UUID, set by the writer        | never sent or changed; it orders rows the paging walks read (ADR 0005) |
  | A playback id                                                               | 64 characters                    | the report is refused (`invalid_args`); start makes it                 |

  The rest of the write is kept, so a scan never fails on an over-long field. A cut id would name
  another title, so an id is dropped. A key or a digest over its maximum keeps its leading part
  and adds a SHA-256 of the whole (`uniqueWithin`), so two keys that differ anywhere, even past
  the cut, stay two rows, and the same key always maps to the same stored key, so a rescan finds
  the row it wrote. Every key is derived from what a scan, a metadata job, or a person job sent,
  never from a stored field a fitter may have cut: a title's match key from the scanned title, a
  collection's source key from the scanned collection, and a person's key from a provider's id
  once one is known, else from the scanned name, after which merging ids keeps the stored key.
  A person also keeps a name key (`nameKey`, indexed), `name:<normalized name>` from the name a
  scan first sent and bounded the same way, so a credit without ids finds them by it, never by
  comparing a scanned name with the stored one; a provider's id that turns up later attaches to
  that row, which takes the provider's key and keeps its name key.
  A match command's provider id over 256 characters is refused, since an admin
  typed it.

- **Proof.** A unit test builds one document per table at the smallest a fitter can leave it,
  every identity field at its maximum, every free text at 64 characters, and lists empty, all in
  3-byte UTF-8 characters, and checks it fits its bound, so fitting always reaches its target.

### Folder identity (amended 2026-11-10)

Two spellings can name one folder: a symbolic link, a bind mount, or a case-insensitive or
Unicode-normalizing mount. Path checks in `core/folders.ts` cannot see that, so every scan also
claims its library's folders by what they are on disk.

- Right after `core/scans:target` and before any write, the scanner calls
  `core/scans:claimFolders({ lease, kind, bootId, folders })` under `withScanLease`. Each entry
  names one of the library's current folders, its chain, and its source. The chain is the
  `<dev>:<ino>` identity of the folder's real path, then of each parent up to `/`: 1 to 64
  identities of at most 48 characters each. The source is `{ device, path }`: the folder's mount
  device as `<major>:<minor>` of at most 48 characters, and its path within that device's
  filesystem, `/` for its root, absolute without empty, `.`, or `..` parts, at most 4,096
  characters and 64 parts. It is null when the server has no mount table. `bootId` is the host's
  boot id, or null; the core keeps it for diagnosis only.
- The call throws, as a server defect, when it gets more than 16 folders, a folder that is not
  the library's, a missing or repeated folder, a malformed chain, or a malformed source.
- A claimed folder is a `folderClaims` row `{ libraryId, folder, since, bootId }` and its keys,
  `folderClaimKeys` rows `{ claimId, libraryId, since, key, depth }`: `i:<dev>:<ino>` for each
  identity of its chain, the folder itself at depth 0, and one `s:<device>:/<part>/…/` row at
  depth 0 for its source, each part the first 16 hex digits of its SHA-256 and `/` alone for the
  filesystem's root. A folder reaches another when its identity chain holds the other's own
  identity, or when its source key starts with the other's, so on one device its source equals
  the other's or lies inside it by whole parts. A claim reads, for each folder, the rows that
  hold its own identity at any depth and the source keys that start with its own (folders at or
  inside it), and the depth-0 rows of each parent identity and each parent source path (folders
  around it). Identities catch links and other spellings, case-insensitive ones included; source
  paths catch a bind mount of a folder inside another, whose mount point's parents never reach
  the other's identity.
- Ownership persists in the core and does not depend on the boot. `since` is when the library
  first claimed the folder, and every later claim of the same library and folder keeps it. Two
  overlapping claims go to the older, the lower `since`, and the lower claim id on a tie; a folder
  claimed for the first time loses a tie. A folder that another of the library's own folders
  reaches is refused, which is one folder sent twice through a link. An older claim of another
  library refuses the call with `{ claimed: false, folder, rescans }`, `folder` being the first
  such folder of this library in path order. A refusal writes only `folderClaimWaits` rows
  `{ libraryId, ownerLibraryId }`, one per older library, at most 16 a refusal, deduped, and at
  most 64 waiters per owner and 64 owners per waiter; past those it records nothing and that
  library is rescanned by hand. `rescans` is true when a wait row exists for this library on each
  older library of that folder, so the core rescans it once they let go; it is false past the
  caps and for a folder that another of the library's own folders reaches. The library's earlier
  claims stay, the scanner stops, and the library stays refused until the older claim goes.
- When the caller is older, as when a younger library slipped in while the caller's identities
  had changed across a reboot, the call succeeds and takes the younger claims of the folders it
  reaches, at most 4 a call: each loses its keys and is marked `lost`, so its library still has
  the folder configured but owns it no more. Each younger library then waits on the caller and is
  disowned in the same mutation: its running scan is canceled, so its `finish` answers
  `canceled`; its purge is scheduled through `core/scans:purgeLibrary`; and the libraries waiting
  on it are rescanned, since it let a claim go. A later claim of the lost folder by its library
  starts a new claim from that time.
- Every scanner write is fenced by ownership. `withScanLease` reads the library's claims, one
  range of at most 16, in the same mutation as the write, and a library that does not own every
  folder it has, because one was lost or it never claimed them, has its scan canceled and the
  call answers `canceled`, as for a deleted library; `target` and `claimFolders` run before the
  claim and skip the fence. The taking writes the claim the fence reads, so Convex runs an
  eviction and a write of the evicted scan one after the other: the evicted scan writes nothing
  after the eviction commits. The purge keeps a row only inside a configured folder that the
  library has not lost, so an evicted library's rows there go, batched and budgeted as any purge;
  a folder it never claimed keeps its rows, as an import writes them before any scan.
- When an owner lets a claim go, its waiting libraries are rescanned on their own: `setFolders`
  deletes the claims of the folders it removes, `remove` deletes all of the library's claims and
  its own waits, a claim replaces rows that changed, as after a reboot that changed identities,
  and an eviction takes the younger claim. Each schedules `core/libraries:wakeWaiting` for that
  library, which deletes up to 16 of its waits a call, queues each waiting library's scan through
  the same code that queues every other scan, and schedules itself while more wait. A waiting
  library that still overlaps is refused again and waits again.
- A successful claim keeps each folder's claim, replaces its keys when they changed, and an
  unchanged claim writes nothing. At its largest, 16 folders of 64 identities and a 64-part
  source, it reads at most 17 ranges and 1,040 rows of its own and at most 2,064 ranges of
  `by_key_depth`, each at most 4 rows past its own. It deletes at most 1,040 key rows and inserts
  at most 1,040, and evicts at most 4 claims of 66 rows. Convex counts each delete among a call's
  4,096 reads, so that is about 3,400 reads, inside that limit and the 32,000-document and
  8,192-write limits; keys are short, so the reads stay a few MiB. A stack test runs it at that
  size. A range that fills its 4 rows, or more than 4 younger claims, schedules
  `core/folderClaims:settle`, which reads the library's claims again and takes the younger claim
  of each overlapping pair from its library, the library's own claim included, until none is
  left. Two concurrent claims that overlap each read a range the other
  writes, so Convex runs them one after the other.
- Before it claims, the server checks each folder as the scan would: it resolves, is a folder, and
  lies inside `LIBRARY_ROOTS`; a missing folder fails the scan to be retried and an unapproved one
  fails it for good. It then reads each folder's chain with the folder's real path and `stat`
  with 64-bit device and inode numbers for it and each parent, and the boot id from
  `/proc/sys/kernel/random/boot_id`. It reads each folder's source from `/proc/self/mountinfo`:
  the innermost mount holding the real path (the last one listed when mounts stack on one point),
  its device, and the mount's root within that device's file system joined with the path below
  the mount point. A bind mount of a library folder's child so names a path inside that folder on
  the same device, though its inode chain never reaches the folder. Without a mount table, or for
  a source path longer than the core takes, it sends no source and the inode chain alone decides.
  A refused claim fails the scan with "Another library already uses <folder> under another path"
  and writes nothing. The message says the library scans again on its own when the core answered
  `rescans: true`, and asks for a manual scan once the owner lets go when it answered `false`
  (past the wait caps). The server reads `known` and writes only after the claim, since every
  write, the listing included, is fenced on ownership and an unowned scan is canceled.

### Rescans after a file changes (amended 2026-11-10)

On the core a scan writes only under its job's lease, so the server no longer scans by itself when
a file changes. It asks the core to queue a scan. Until now "Left for later units" held this for
`p4-movies-cutover`.

- `core/scans:changed({ path })` is a server function. `path` is an absolute path of at most 4,096
  characters: a file or folder that changed, or an approved library root. Any other path is
  refused with `invalid_args`.
- It queues a scan of every movies library with a folder that is `path`, holds it, or lies inside
  it. It checks up to 32 parent folders, the deepest a folder may be. It reads the folders inside
  `path` 64 per call, and scheduled calls read the rest.
- The path's plain leading parts decide where it meets folders. Repeated and trailing slashes and
  `.` parts are dropped, as a folder is written down. A `..` part ends them, and nothing lies
  inside such a path.
- Each scan is queued through `queueScan`, with its scan kind's dedupe, so a change joins a scan
  already queued or running. A change that joins a running scan, which may already have passed the
  changed folder, marks the library `rescanAfter`. When that scan stops running, one more scan is
  queued (`followUpScan` in `core/jobs/store.ts`, on every way a job leaves `running`); a scan that
  goes back to the queue starts over, so it only clears the mark. A stream of changes during a long
  scan therefore queues one scan after it, as old movies' monitor rescanned after its running scan,
  and never restarts the running one.
- Music libraries are skipped, since music has no scanner on the server yet.
- The server's library monitor, `apps/media/src/core/core-rescans.ts`, watches each approved root
  and sends the paths a burst of changes named. A path inside another sent path is left out. A
  burst that names no path or more than 32 sends the root instead. The monitor also sends the root
  at startup, on the reconcile interval, after a watcher restarts, and when a polled root changes.

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

- A library whose last manager's account is deleted has no one who can see it. Account deletion
  does not exist yet; the unit that adds it decides who inherits.
- Guest links (p3-guests) must be a capability of their own, not grants on a title, or items would
  need grants of their own.
- A purge after a folder removal pages the whole library. A domain whose libraries hold many
  items can page only the removed folders' path ranges instead.
- A recount of a library's items from the domain's rows, for a count a defect moved wrong.
- Totals of a library's items by kind of item belong to each domain's port. Movies counts titles,
  episodes, and files (above); music's tracks and albums come with its port.
