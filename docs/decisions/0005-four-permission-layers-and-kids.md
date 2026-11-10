# 0005. Check access in four layers and make kids restricted users

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the first role and the `admin` scope,
  and again the same day with the permissions as built. Amended 2026-11-06 with the service
  principal's scope and key, and 2026-11-09 with the guarded server functions, movies' facts,
  and the movies commands' access.
- Decisions: D16, D17

## Context

Movies has roles (`owner`, `admin`, `member`, `service`) and scopes on API key and device sessions
(`read`, `play`, `account`, `manage`, `admin`, `media-service`). Its kids are profiles with a
maximum age rating, and PINs keep a kid inside one. Music has `owner`, `admin`, `member`, and
`guest` roles and no scopes. It shares a library through a visibility field (`shared`,
`restricted`, `private`) and a playlist through its own `playlistShares` table. Each resource kind
shares in its own way.

With profiles gone (ADR 0003), a kid is a user, and the merged product needs one place that
decides what each principal may see and do.

## Decision

Every access check passes four layers.

1. **Platform role.** `owner`, `admin`, `member`, or `guest`. Service accounts are a separate
   principal type, not a role.
2. **Credential scopes.** Every session and every API key carries scopes, such as `movies:read`,
   `music:play`, and `admin`.
3. **Grants.** One generic table holds every grant. A row names a principal or a group, a resource
   type, a resource id, and a level of `view`, `edit`, or `manage`. Grants cover libraries,
   playlists, and collections. Groups exist from the start.
4. **Content restrictions** on a user.

Admins manage accounts, not content. A private resource stays invisible to admins in the apps.

A kid is a normal user with a password and restrictions an admin sets:

- a maximum movie rating,
- hidden unrated content,
- the libraries they may use,
- a music explicit filter.

A kid cannot change their own restrictions. Admins are enough, so there is no guardian link.

## Consequences

- A new resource type, such as a later product's albums, needs a resource type in the grants table
  and no new table.
- Scopes carry the domain name, so a key can play music and not movies.
- An admin can reset a user's password but cannot open that user's private playlist in the apps.
- Kid rules live on the user. The lock rules for kids on shared devices are in ADR 0006.

## Alternatives rejected

- Kids profiles under a parent account. A kid is a user instead (ADR 0003).
- A guardian link between a kid and a parent. Admins already set restrictions.
- Admins who see all content. Admins manage accounts only.
- A sharing table per resource kind, such as music's `playlistShares`. One grants table replaces
  them.

## Edge cases settled

- A kid who signs in with their own password still cannot lift their own restrictions.
- Unrated content is hidden from a kid when the admin turns that restriction on.
- A grant to a group reaches every member of the group.
- A service account is its own principal type. It holds no platform role.
- `account` is the first credential scope. It lets a session manage its user's own credentials,
  so a key without it cannot make a key or approve a device that outlives it (ADR 0004).

## Roles and the admin scope as built (amended 2026-11-04)

The accounts build (ADR 0003) needed the platform role and a way to gate admin commands before
the rest of this ADR lands.

- `users.role` is `owner`, `admin`, or `member`. `packages/commands/src/scopes.ts` lists the roles
  once, and the generator emits the `role` and `assignableRole` validators that the schema and the
  command arguments use. `guest` arrives with guest links (ADR 0007).
- `admin` is the second credential scope. `roleScopes` in `convex/core/sessions.ts` gives the
  owner and admins `account` and `admin`, and members `account`. `heldScopes` cuts every session
  down to its user's role on each call. A demotion ends every session and key of the person, and
  so every invite and reset link they made, for good (ADR 0003).
- An admin command declares the `admin` scope, so the generated function refuses a session
  without it. Rules about the target account live in one pure function, `manages` in
  `convex/core/accounts/users.ts`: an admin acts on someone else who is not the owner.
- The permissions build replaces `roleScopes` and `heldScopes`, adds the domain scopes, and folds
  `manages` into `can(principal, action, resource)`. A change that takes away the right to make
  invites or reset links must still end the person's sessions. The links check the maker's
  current role and session generation, and only the generation remembers that the right was lost
  in between.

## Permissions as built (amended 2026-11-04)

The permissions build added the four layers to the core. The code is in
`packages/platform/convex/core/permissions/` and `convex/core/restrictions.ts`. The vocabulary is in
`packages/commands/src/scopes.ts` and `packages/commands/src/access.ts`, and the generator emits it.

### One pure decision

`can(principal, action, resource)` in `permissions/policy.ts` reads no database. Three tables
hold its rules, each typed by its list of actions, so a missing or extra row fails to compile.

| Action              | On      | Needs                                                                                |
| ------------------- | ------- | ------------------------------------------------------------------------------------ |
| `view`              | content | `<domain>:read`, and a `view` grant                                                  |
| `play`              | content | `<domain>:play`, and a `view` grant                                                  |
| `edit`              | content | `<domain>:edit`, and an `edit` grant                                                 |
| `manage`            | content | `<domain>:edit`, and a `manage` grant; it shares, renames, and deletes               |
| `promote`           | account | `admin`; someone else; an admin or a member without restrictions                     |
| `demote`            | account | `admin`; someone else; an admin or a member                                          |
| `resetPassword`     | account | `admin`; someone else; an admin or a member                                          |
| `restrict`          | account | `admin`; someone else; a member                                                      |
| `viewRestrictions`  | account | nothing for yourself; otherwise `admin`, and anyone but a guest or a service         |
| `joinGroup`         | account | `admin`; anyone but a guest or a service, yourself included                          |
| `handOverOwnership` | account | `admin` and being the owner; someone else; an admin or a member without restrictions |
| `invite`            | server  | `admin`                                                                              |
| `manageGroups`      | server  | `admin`                                                                              |
| `manageFolders`     | server  | `admin`; making a library or changing its folders (ADR 0024)                         |

ADR 0006 adds the tile, approval, and device actions, and `listOnSharedDevices`,
`resetUnlockCode`, and `manageDevices`. ADR 0019 adds `change` on a setting and `keep` on a
download. ADR 0017 adds the group-session actions, whose loader is `requireTogether` in
`together/access.ts`. ADR 0007 adds `configureGuests`, `allowSharing`, and the share-link actions
`offer`, `make`, `open`, `hold`, `play`, `audit`, `revoke`, and `see`.

The answer is `allowed`, `hidden`, or `forbidden`. Content with no grant, content a restriction
hides, and any content for a service are `hidden`, which fails `not_found` with the same message
as a row that does not exist. So a private thing stays invisible to everyone else, admins and the
owner included. `forbidden` refuses something the principal can see but may not do.

Handlers never pass rows to `can` themselves. Loaders read the facts and decide:
`requireContent`, `visiblePage`, and `requireItems` in `permissions/grants.ts`, and `requireAccount` and
`requireServer` in `permissions/authorize.ts`. A person principal carries how its session signed
in, so a rule such as "no API key makes a guest link" lives in `can` too. A link check has no
session, so it asks `can` about `principalOf(maker)`, the principal the maker's row alone allows,
with no session kind.

### Roles and scopes

| Role   | Scopes                                     |
| ------ | ------------------------------------------ |
| owner  | `account`, `admin`, and every domain scope |
| admin  | `account`, `admin`, and every domain scope |
| member | `account` and every domain scope           |
| guest  | `movies:play`, `music:play`                |

- The domain scopes are `read`, `play`, and `edit` for each content domain: `movies:read`,
  `movies:play`, `movies:edit`, `music:read`, `music:play`, `music:edit`. `play` does not need
  `read`, so a key for a speaker plays and cannot browse. `edit` covers what the `manage` level
  allows, sharing included.
- `roleScopes` in `packages/commands/src/scopes.ts` is the only role-to-scope table.
  `heldScopes` in `policy.ts` gives a password session its role's scopes and cuts a key's or a
  device's stored scopes to its role's on every call.
- Nobody assigns `guest`. Guest links make guests (ADR 0007). The role cannot browse, search,
  edit, or make keys.
- The generator refuses a movies or music command that declares anything but a scope of its own
  domain, and a core command that declares a domain scope (`domain-scope` in
  `packages/commands/src/check.ts`). So a key with only `music:play` fails every movies command's
  scope check before the command reads anything.
- A role change that takes away any scope ends every session and API key of the person
  (`endsCredentials`). Losing `admin` is such a change, so losing the right to make invites and
  reset links still ends the links the person made (ADR 0003). A unit test checks every pair of
  roles.

### Service principals

A service principal is a `users` row with `kind: "service"` and a `name`. It has no role,
username, password, or restrictions, so the schema cannot give it a role.
`core/accounts/host:createService` makes one. Every account action on a service is refused, so no
admin can give it a role, a reset link, restrictions, or ownership.

- A service signs in only with an API key that `core/auth/apiKeys:issueServiceKey` issues (ADR
  0010). The key holds `media-service`, the one service scope, listed in `serviceScopes` in
  `packages/commands/src/scopes.ts`. No role allows a service scope and no command requires one,
  so `heldScopes` never gives one to a person. `apiKeys.create` takes credential scopes only, so a
  person cannot ask for it.
- A stored key and the session it opens hold `keyScope`: a credential scope or a service scope.
  `heldScopes` keeps a service at no credential scope, so `requireCaller` still refuses its
  sessions and every command answers it `forbidden`. `heldServiceScopes` reads the service scopes
  of a service's key session.
- `serviceOfSession` in `core/auth/caller.ts` is `callerOfSession`'s mirror: `unauthenticated`
  when the session is not live, `forbidden` for a person, or for a service whose key lacks the
  scope.
- Server functions are public, and `requireService` guards each one (amended 2026-11-09, phase 4).
  `serverQuery` and `serverMutation` in `core/lib/serverFacing.ts` build them. Each runs
  `requireService(ctx, "media-service")` before its handler, and that guard reads the caller's
  token and calls `serviceOfSession`. A person's session gets `forbidden`, and so does an API key,
  admin scope included, because a key a person makes cannot hold a service scope. A call with no
  session gets `unauthenticated`. The handler gets the `ServiceCaller` and a context without
  `auth`, as a command handler gets its `Caller`.
- Server functions are not commands (D23). They have no declaration, no SDK method, and no CLI
  word, and `commandRefs` never lists them. Lint allows a public function in `convex/` only
  through these two builders or the generated command list: `no-restricted-imports` bans the
  public `query`, `mutation`, and `action` builders everywhere in `packages/platform/convex/`
  except `core/lib/serverFacing.ts`, and the generated `register` functions live in
  `packages/platform/commands/`.
- The builders are generic over the argument and result validators with no cast. The handler's
  arguments arrive as a typed rest tuple, and the result validator reaches `query` widened to its
  constraint, so Convex checks the result at run time and the `api` reference keeps the
  handler's own result type. ADR 0024 had rejected a generic scanner-callback builder because the
  same typing seemed to need casts.

### Grants and groups

- A `grants` row names a resource type, a resource id, a principal, and a level. The principal is a
  user id, a group id, or `household`, stored as one value so it can be indexed. The household is
  every person on the server but guests, which covers the libraries both old products shared with
  everyone.
- Resource types live in one registry, `resourceTypes` in `packages/commands/src/access.ts`. Each
  entry names its table. Only containers are grantable: a library now (ADR 0024), a playlist or a
  collection later. A title or a track has no grants of its own: it is seen at its library's level,
  through `requireItems`, which decides on the library once and then on each item's facts. So a
  title list pages the domain's own index after one library check, and never merges grant ranges.
- `core.permissions.grants.set`, `remove`, and `list` share anything in the registry. Their
  `resource` is a `{ type, id }` pair derived from the registry, so an id of another table fails
  validation. `set` refuses API keys, because a leaked key could grant its own person access that
  outlives the key. `list` needs `manage`, and names each user and group.
- A grant or revoke needs `manage`. A person who can see something can leave what was shared
  with them. Only a
  person can hold `manage`, and a group or the household gets `view` or `edit`. Removing or
  lowering the last `manage` grant is a `conflict`. The mutation that creates a resource makes its
  creator the first manager (`grantCreator`).
- Admins hold no level they were not granted.
- Admins manage groups through `core.permissions.groups.*`. Adding someone to a group refuses API
  keys, because a leaked admin key could otherwise add its own person to every group. Group membership is read on every
  content check, so a person added to or removed from a group gains or loses its grants on their
  next call. Removing a group deletes its memberships at once and deletes its grants in scheduled
  pages. A group's name follows the device-name rule (ADR 0006): an admin types it, so one that
  breaks the rule is refused with `invalid_args`.
- Limits: 1,000 grants per resource, 16 groups per person, and 500 people per group.

### Restrictions

- They live on the member's `users` row. The schema allows them on members only, because an
  admin could lift their own through another admin they promote. The caller's row is already
  read on every call, so a restriction check reads nothing more.
- The fields are `maxMovieAge` (the highest minimum viewer age, 0 to 21, on the scale of
  `packages/contracts/src/content-rating.ts`, where PG is 7), `hideUnrated`, `hideExplicitMusic`,
  and `libraries` (null for every library the person's grants reach).
- `core.restrictions.set` needs `admin`, refuses API keys, and works only on a member who is
  someone else. `core.restrictions.get` shows your own, or as an admin anyone's, which is null
  for someone who is not a member.
- A kid is a member with restrictions (`isKid`). Limits that hide nothing are stored as no
  restrictions. An admin lifts them before promoting the kid or
  handing them ownership.
- A change applies on the person's next call and ends no session.
- What restrictions do to a thing depends on where it sits, a `Placement` that every content
  resource carries, so no check is skipped because a field is empty:

  | Placement  | Allowed-libraries list                                                   | Rating limits                                        |
  | ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
  | `library`  | checks the library itself                                                | none: a library has no rating, each item has its own |
  | `item`     | checks the item's library                                                | checks its facts; an unrated movie is `unrated`      |
  | `unplaced` | its type chooses: `hides`, or `allows` and each item it holds is checked | its own facts, or none for a `container`             |

  `placements` maps each grantable type to its placement and fails to compile until a new type
  picks one. A thing in no one library, such as a playlist, is `unplaced` and must state both
  choices.

### Reads

- A call reads the person's reach once (`reachOf` in `permissions/grants.ts`): their group
  memberships, one index range and a document per group. Each content check then reads 2 grants,
  the person's own and the household's, and unless one of them is `manage`, one grant per group.
  A call that checks many resources reads the memberships once, not once per check.
- Convex fails a call that reads more than 4,096 index ranges, with "Too many reads". Each
  `db.get` and each indexed query counts as one, whether it finds a document or not. A list that
  decides each row through grants sizes its page from what one row's check reads, so the call
  stays under `PAGE_ROWS_MAX` (1,000) reads and has fewer than that in flight (`decidableRows`). Its
  page holds fewer rows the more groups the person is in. A page that a reactive client reloads up
  to its end cursor holds every row up to it, because Convex then ignores `maximumRowsRead`. Past
  that size it decides none of them and asks the client to split it (`paginateAtMost`). The
  library list below works this way. So do the group session queue (ADR 0017), 42 entries a page
  for a person in 16 groups and 140 for one in none, and the downloads list (ADR 0019), 44 rows a
  page for that person and 164 for one in no group. A movies item reads its row, its title, and its
  library, one more than the probe items these were first measured on (44, 164, 46, and 196).
- A list page merges the index ranges of the person's own, household, and group grants after the
  cursor, so it reads at most 1,000 documents however many grants the table holds. On the dev stack
  with more than 1,000 grants in the table, a 50-row page read 168 documents.
- A page reloaded up to its end cursor returns every row up to it, or asks the client to split it.
  Restrictions can make a page short.

### Movies facts

- A title's facts are `ratingOf(overrides.ageRating ?? ageRating)`: the minimum viewer age an
  admin set wins over the scanned one, and a title with neither is `unrated`. An episode and a
  file carry their title's facts. `movies/items.ts` derives them, and the item and download
  loaders hand them to `can()`, which stays the only decision (amended 2026-11-09).

### Test seam

`convex/movies/probe.ts` seeds rated titles in real movies libraries, and
`convex/core/libraryProbe.ts` seeds `probeItems` tracks with an explicit flag in music libraries
until music's own rows exist (ADR 0024). Each seam's internal `open` and `page` take a real
session's id and run `callerOfSession`, which is everything `requireCaller` does after it reads
the token. A stack test signs in for real, with a password or a key with chosen scopes, and calls
them with the deployment admin key. Libraries themselves are shared and read through the real
commands. A stack test calls a server function as a service principal it signs in with a key
from `issueServiceKey`, through Convex's `/api/run` route with the session's token, since the
admin key reaches the functions with no identity and the guard refuses that.

### Left to later units

- Guest principals and links: built, see ADR 0007. A guest holds no grant (`keyOf` refuses one),
  so their reach has no keys and what they may play comes only from their link.
- Public server functions guarded by `media-service`, and the guard that reads their token:
  built in phase 4, see Service principals.
- Locking shared-device tiles for kids, from `isKid`: built, see ADR 0006.

### Edge cases settled

- An admin who resets a person's password can sign in as them and see what was shared with them.
  This ADR keeps admins out of private content in the apps only. The reset ends every session the
  person had, so they notice. Music's rule that only the owner may reset someone who sees more
  than the admin was not carried over.
- An admin can add themselves to a group. A grant to a group trusts the admins who run groups.
- A key whose person can see a thing, but which lacks the scope for the action, gets `forbidden`,
  not `not_found`. The person could see the thing anyway.
- Unrated movies stay visible to a kid unless `hideUnrated` is on. Old movies always hid them
  from limited profiles. D17 makes it a switch of its own.
- The allowed-libraries list is not checked for libraries that exist. Checking would tell an admin
  which private libraries exist.

Rejected in this build:

- Access declared on each command and checked by the generated wrapper before the handler runs.
  Lists and commands whose action depends on an argument, such as `setRole` (`promote` or
  `demote`), fit no single declared target. The movies port looked again and kept loaders; see
  Movies commands below.
- A table of each person's effective level per resource. A household grant would write a row per
  person, and a group change a row per resource shared with the group.
- Admins who see all content, and a `play` or `edit` scope that needs `read`.

## Movies commands (amended 2026-11-09)

The movies commands (ADR 0009) port old movies' actions onto the core. A person's progress,
history, and list are theirs (D12, D36), in `watchProgress` and `myList` keyed by user.

### Title commands do not declare their target

This build left open whether a command that opens one title should declare it, so the generated
wrapper checks access before the handler runs. The port keeps loaders, and the generator stays
as it is.

- Of the 27 movies commands, 10 open one title by its id and decide it. The rest decide many
  titles (home rows, lists, search, genres, history, the list, collections, people), open a
  title through another row (an episode, a file, a person, a collection), decide by what a
  guest's link covers (`movies.play.start` and the play reports), or need no decision
  (`movies.myList.remove` takes a title off the caller's own list). A declared target fits only
  the 10.
- The 10 call one loader, `requireTitle` in `convex/movies/access.ts`, as their first line. It
  reads the title, its library, the caller's reach, and the library's grants, and asks
  `can(principal, action, item)` with the title's facts. A title being purged, one in no movies
  library, and one the caller may not see all fail `not_found` with one message; one they see
  but may not act on fails `forbidden`. The declaration would save that one line and add a
  second way to check access.
- Metadata match, refresh, and edits ask `edit`, so they need `movies:edit` and an `edit` grant
  on the title's library. The list and marking watched ask `play`, as old movies asked the `play`
  scope.

### Lists across libraries

- `movies.titles.list` keeps one order across every library, as old movies' list did: by name,
  newest added, or newest year. It pages one household-wide index with `paginate`, the titles
  table's own (`by_sort`, `by_added`, `by_year`, and the same by kind) or the genre rows'
  (`by_genre_*`, `by_kind_genre_*`), and decides each row through `can()` at its library's
  level. Titles the caller may not see, restrictions, and filters make a page short or empty
  while its cursor goes on. With a library named, the list pages that library's own index after
  `requireItems` decides it.
- A season's episodes come a page at a time, so a season of any length lists whole. Where a show
  resumes comes from the person's newest progress row on it, through the
  `(user, title, played at)` index.
- A row whose title is gone or being purged is skipped, as old movies skipped it; the purge
  leaves the person's rows behind.

### One read budget per call

Convex fails a call past 4,096 index ranges, 32,000 documents, or 16 MiB read (ADR 0013). Every
access-checked movies read stays under all three by one rule, in `movies/reads.ts`.

- **Real costs.** A `get` is one range and one document; a query is one range and the rows it
  returns; a document counts at a size estimate for its table (512 bytes for a grant, a library,
  or a list or progress row; 6 KiB for a title; 2 KiB for an episode, a person, or a
  collection). Deciding a library is charged once per call, at what `reachOf` and `levelOn` read:
  the library and one grant query per grant key (the person's own, the household's, and each of
  up to 16 groups). The caller, the session, and the reach are charged first, as
  `decidableRows` charges them. Lookups that find nothing, such as next-episode scans, are
  charged too.
- **One total.** A call spends at most 3,000 ranges, 30,000 documents, and 12 MiB from one
  shared total, which leaves headroom for estimates that undercount. Parts of a call take shares
  of what is left (home rows: continue watching first, then the list, then the library walk, then
  each row's merge), never a minimum per library.
- **Pages are sized, never cut.** A paginated list sizes its page before it reads, so its rows
  can never run out of budget: history and the list by `decidableRows` from each row's own
  reads, the title list the same way, and collections by what each collection needs to decide
  all 200 of its members at the worst cost, each in a library of its own, with each collection
  on a page given an equal share of the page's budget. So a page's continuation is always exactly
  after its last row, and no row is skipped. Only a collection that alone costs more than a
  call can pay (a person in many groups, with members in more libraries than a call can check)
  runs out of its share; it stays listed with the titles it decided.
- **Aggregates answer the best for their budget.** Home rows, genres, and similar titles walk
  every movies library shared with the caller with `visiblePage`, as many rows a step as both
  `visiblePage`'s sizing and the budget allow, keeping each step's continuation, with no fixed
  number of steps; music libraries and libraries the caller cannot browse cost a step but never
  push a movies library out. They then merge the libraries' own newest titles from the
  `(library, kind, added)` index, a batch at a time, reading a library further only while its
  titles are still among the newest, so a library of newer titles of another kind or of titles
  the caller may not see hides nothing. When the walk cannot finish within its share, the
  aggregate uses the libraries it covered; when a merge runs out, it answers the newest it found
  among what it read. Search, a person's credits, people search, and a collection's titles decide
  rows until the budget runs out and answer what they decided; continue watching keeps the most
  recent items it could decide.

### Playback

- `movies.play.start` decides one file. A person in the household needs `play` on the title
  through their grants, decided before any file is chosen. A guest's link decides instead,
  through `playableBy` in `permissions/items.ts`: a link to the title covers each of its files,
  one to an episode that episode's files, and one to a file that file (ADR 0007). It issues a
  personal `play` ticket for the file, which names the caller's session and lasts at most 6 h
  (ADR 0011).
- Old movies' playback sessions do not come over. A start answers `startedAt`, each report
  carries it, and the progress row keeps the session and start of the playback that last
  reported. A report from an older start on another session is stale and changes nothing, as old
  movies' reports from an older playback session were.
- Marking a whole show watched or unwatched writes a page of up to 500 episodes in its call and
  schedules the rest, a page a call, inside the call budget of ADR 0013.
