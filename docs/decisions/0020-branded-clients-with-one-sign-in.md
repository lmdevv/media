# 0020. Ship a branded client per product on a shared base, with one sign-in

- Status: Accepted, 2026-11-03. Amended 2026-11-06 with the account client as built,
  2026-11-07 with one sign-in session per browser (D52), 2026-11-09 with what the iOS keychain
  holds (D48, D59), 2026-11-10 with the movies client on the web as built (D52, D57, D62), and
  2026-11-11 with the movies iOS app as built (D12, D48, D51, D56, D59, D62, D64).
- Decisions: D12, D38, D39, D40, D48, D51, D52, D56, D57, D59, D62, D64

## Context

Movies has a web app with a Netflix look and an iOS app with the Apple TV app look, both from the
Paper file `[movies]`. Music has its own web app and iOS app. Both use shadcn components restyled
through design tokens. Each product's apps sign in on their own, and each has a "Search ⌘K" field
that opens a command menu.

With one account system (ADR 0003), a user who signs in once expects every product to know them.

## Decision

- **Clients.**
  - `apps/web-account`, the account client at `/` (ADR 0015).
  - `apps/web-movies`, with the Netflix look.
  - `apps/web-music`, with an Apple Music look in light mode and a Spotify look in dark mode.
  - `apps/mobile-movies` and `apps/mobile-music`, both over `@media/mobile-core`.
- **Design.** Each product looks different. They share a shadcn base and a type scale, and each
  has its own accent and styling. The exact split is decided in Paper during the port.
- **One sign-in.**
  - On iOS, a shared keychain access group under one Team ID holds the server connection and the
    account. Each app mints its own session silently and appears as its own device.
  - On the web, the clients share one origin.
- **Search ⌘K** searches only the current client's catalog.

## Consequences

- Signing in to the movies iOS app lets the music iOS app sign in without asking. Each app holds
  its own session and shows as its own device.
- On the web, one origin means one sign-in state for `/`, `/movies`, and `/music`.
- Shared components live once, and product styling stays in each client.
- Searching in the movies app never returns albums.

## Alternatives rejected

- One app for both products. Each product has its own branded client.
- One shared session across iOS apps. Each app mints its own session and shows as its own device.
- A search across every catalog. ⌘K searches the current client only.

## Edge cases settled

- Every iOS app must ship under the same Team ID to share the keychain access group.
- The shared keychain holds the server origin, the user id, and one device grant for the phone
  (D48). Each app exchanges the grant for a session of its own and keeps that session in its own
  keychain. Revoking the grant signs every app on the phone out. Ending one app's session signs
  out only that app, which then asks for the password and does not exchange the grant again (D59).
  ADR 0006, "Device grants as built", records how the core builds it.
- The exact split between shared and per-product UI is open until the port, and Paper decides it
  (`docs/architecture.md`, "Open").

## The account client on the web as built (amended 2026-11-07)

`apps/web-account` is the first web client on the core. It talks to the core only through the
platform SDK. Its session layer is `apps/web-account/src/session/`, and the browser's record is the
SDK's `layerShared`, `keepSession`, and `holdSignIn` in `packages/sdk/src/token-storage.ts`.

### One sign-in session per browser (D52)

A browser holds one session, whoever's, and every client on the origin (`/`, `/movies`, `/music`)
uses it and follows its sign-in, renewal, and sign-out across tabs. Switching person is signing the
current person out, then signing the next one in. A personal browser saves no one else for later.
A shared device, such as a TV, also holds one session: the tile open now. Its picker on `/` opens
one tile at a time, and opening a tile ends the one it replaces. This matches the core, which keeps
one session per device (ADR 0006), so the account client and the core agree on who is signed in.

### What a browser holds

One origin's IndexedDB database `media` holds the record, in one object store `kv` of string keys.
`localStorage` holds nothing credential-bearing.

| Key                       | Holds                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `media.device`            | the device: its id, its code, and the number of the session kept last |
| `media.session`           | the browser's one session: its tokens; absent while signed out        |
| `media.revoked:<session>` | a sign-out, never deleted                                             |
| `media.signOut:<session>` | a sign-out the core has not confirmed, with its tokens, for any tab   |

How the record changes, each row one transaction:

| Holds                         | Event                                                           | Then holds             | Also                                  |
| ----------------------------- | --------------------------------------------------------------- | ---------------------- | ------------------------------------- |
| nothing                       | a sign-in is kept                                               | its device and session |                                       |
| session S, number n, device D | a sign-in on D with a number above n, or on a new device from D | the new session        | S is revoked and its sign-out pending |
| session S                     | a sign-in that loses                                            | S                      | the loser is revoked and pending      |
| session S                     | a renewal over S's exact tokens                                 | S, renewed             |                                       |
| session S                     | a sign-out                                                      | D and n, no session    | S is revoked and pending              |
| D and n, no session           | a sign-in on D with a number above n, or on a new device from D | the new session        |                                       |

Any tab ends a pending session on the core, then deletes its pending record. The revocation
stays.

The device and the session are two keys so that a full store can still delete the tokens alone,
and the browser keeps its device code. They are always changed in one transaction.

### Signing in

The core decides which session lives, and the browser follows its order. Every session the core
binds to a device takes the next number on the device's count: enrolling a personal device
answers it as `joinSequence`, and a tile's comes from `core.auth.sessions.current`.

- A sign-in starts on a client of its own whose store is memory (`holdSignIn`). It signs in, then
  enrolls the browser's device with the code the browser keeps, or opens the tile with it. The
  session reaches the browser's record only afterwards, with its device and number
  (`keepSession`), because its number exists only once the core has bound it.
- `keepSession` keeps the new session only when the core bound it after the session kept now: on
  the same device with a higher number, or on a new device enrolled from the one the browser kept,
  when the core no longer knew that one. A session the browser signed out is never kept again,
  and keeping the session held now changes nothing.
- The session it replaces, and a session that loses, are signed out in the same transaction: a
  revocation and a pending sign-out. Any tab then ends them on the core, so a loser that is still
  live there, such as one enrolled on a second new device by a tab that raced the first, does not
  stay live. A sign-in that fails on the way is signed out on the core by its own client.
- Two tabs of a new browser that sign in at once each enroll a device. The first kept wins, the
  other loses as above, and its device is left for an admin to remove.
- **One window is accepted.** Two tabs sign in at once on one device. The core binds S2, then S3,
  and ends S2. If S2's answer reaches the browser first, the record holds S2 until S3's answer
  lands, and calls with S2 fail meanwhile, because the core refuses it. A tab whose token or
  refresh is refused reads the record again before it shows signed out. It takes S3 if the record
  holds it, and otherwise signs S2 out only by compare-and-set, while the record still holds S2.
  S3's number is higher, so it is kept either way. **The guarantee:** once both answers land, the
  record holds S3 and every tab uses it. No tab is left signed out, and the core never serves S2.

### A sign-out holds across tabs

The core is the authority: a sign-out ends the session on the server, and the server then refuses
its refresh token and its calls. The browser has to make every tab stop using it, and never bring
it back. IndexedDB's readwrite transactions on one object store run one at a time across every
tab of the origin and work outside secure contexts, so every change reads what it decides on and
writes in the same transaction.

- **Renewal** writes new tokens only while the stored tokens are still the ones the refresh started
  from and the session has no revocation.
- **Sign-out** writes the revocation and the pending sign-out and deletes the session, in one
  transaction. If that fails, as when storage is full, a second transaction deletes the session
  alone, which frees space; the client stays signed out and retries the records. Signing out
  returns once the records are stored, and the client asks the core to end the session in the
  background, backing off from a second to every 30 seconds, until the core confirms. Any client
  that starts, or hears of a write, takes over every pending sign-out. Confirming deletes the
  pending record.
- **Every token passes a transactional check.** Before a client hands out any token, the
  in-memory one included, it reads the session's state in a transaction. The token goes out only
  while the record holds that session and no revocation exists. A read that fails gives no
  token, so nothing leaves unchecked, but it proves nothing about the session: the client keeps
  it, ends nothing, and hands its token out again once the store reads.
- **Only three things ask the core to end a session:** an explicit sign-out, a revocation and
  pending sign-out read from the store, and a session losing a keep (or being replaced by one). A
  store that cannot be read never does.
- **Only the core's revoke confirms.** `core.auth.sessions.revoke` takes any refresh token the
  session ever had, deletes the session and all its refresh tokens, and answers `confirmed`
  whether or not it had already ended. Convex Auth keeps a rotated token's row until the session
  ends, so an old token still proves the session. A refresh that comes back empty proves nothing.
  So a refused refresh reads the record first: it takes another tab's renewal of the session, or
  another session the record holds, and otherwise signs the session out by compare-and-set while
  the record still holds it, which also ends it on the core. The command needs no session,
  because the refresh token is the proof.
- **The `BroadcastChannel` only tells other tabs to read again.** Its message carries nothing, so
  it never carries authority, and a tab never spends a refresh token another tab already rotated.
- **No client clock decides anything.** No record expires, and no answer is refused for its age.
  The core's numbers order sessions, and revocations are never deleted, so a session signed out
  here can never be kept again.
- **Without IndexedDB**, as in some private modes, or when it has not opened within five seconds,
  the browser keeps no sign-in and shows signed out, and a sign-in says to reload the page. It
  never falls back to `localStorage`. The CLI's and old movies' stores are unchanged: a store one
  client owns keeps the session under one key, and the browser's store refuses a bare `save`.
- **What this guarantees.** Once the core confirms a sign-out, no credential of that session works
  anywhere. Before that, every tab stops using it at its next token. The window left is a request
  already sent with a token checked before the sign-out committed.
- None of this needs a secure context. IndexedDB and `BroadcastChannel` work over plain HTTP on a
  LAN or tailnet address, which installs support. Copying uses `copyText` from
  `@media/ui/lib/secure-context`, which `apps/web` shares. The Playwright suite runs a second time
  against the host's non-loopback address over plain HTTP.

### The screen

The screen is one pure function of the server's answer, the session, the picker, and the route
(`session/screen.ts`). Each route declares what it needs: nothing, a sign-in, an account session,
or an admin. Signed out, a shared device shows its picker and any other browser shows sign-in.
Signed in, `/` goes home on a personal device and shows a shared device's picker. A tile session
never has the `account` scope, so account pages tell it to use the person's own device.

### Clients on one origin

D40 asks each client to mint its own session and show as its own device. On the web that would
break the core's one session per device, and the core has no command that mints a session from
another. So clients on one origin share the browser's one session, each running its own SDK client
over the same record, and `/movies` and `/music` never sign in themselves. The core now has D48's
grant exchange for iOS (ADR 0006). The web keeps one session per browser (D52) and does not use it.

### Links carry their secret in the fragment

An invite is `/invite#mi_<id>.<secret>`, and a reset link is `/reset#mr_<id>.<secret>`.

- The browser never sends a fragment, so the secret appears in no request line, proxy log, or
  `Referer`.
- Before the router starts, `session/link-secret.ts` moves the secret into memory and replaces the
  history entry with the bare page. The address bar and history never hold it after the first
  load. Signing in from either page replaces the entry again with `/`. A reload drops the secret,
  and the page asks for the link again.
- Every page sets `Referrer-Policy: no-referrer`, through a meta tag in `index.html` and a header
  from the Vite dev and preview servers. The production server sends the header once it serves
  this client (phase 4).
- `/device?code=` keeps its code in the query. The user code is not a credential. Only the
  device code, which never leaves the waiting client, redeems the sign-in, and approving needs a
  signed-in account. RFC 8628 puts the same code in its `verification_uri_complete`.
- Old path links, `/invite/<code>` and `/reset/<code>`, are refused. Installs start fresh (D03).
- The account client's Playwright project keeps no trace, screenshot, video, or page snapshot of a
  failure, only text, because its pages and requests carry passwords, tokens, and link codes. After
  every run, a check reads `test-results`, which is what CI uploads, traces included. It fails the
  run and deletes any file that holds a core secret, a JWT, a Convex Auth refresh token, or one of
  the passwords the tests make.

### Rejected

- Several people's sessions in one browser, with a picker of saved people (rounds 1 to 9 of
  #121). It needed a person-to-slot mapping, staging slots, promotions ordered per person and per
  device, and device epochs, and every round of review found another cross-tab race in that
  machinery. D52 settles that a browser holds one session.
- One shared session key with the other people's tokens stashed elsewhere and swapped in. The
  stash goes stale at the first refresh, and Convex Auth then ends the session as reused.
- `storage` events as the notification. They fire only for `localStorage` writes, and the store
  makes none; a `BroadcastChannel` tells the other tabs instead.
- Web Locks around each write. They exist only in secure contexts, and a lock does not make
  another process's copy of `localStorage` current.
- Any session state in `localStorage`. Four rounds of review each found a new interleaving, because
  nothing there checks and writes as one step. IndexedDB transactions do.
- Keeping a new session as soon as it signs in. Its number on the device exists only once the core
  binds it, so the browser could not tell an older sign-in from a newer one.
- Secrets in the path or the query. Both reach the server's request log and any proxy in the
  first request, and stay in history until the link expires.

## The movies client on the web as built (amended 2026-11-10)

`p4-movies-cutover` moved `apps/web` to `apps/web-movies`, the package `@media/web-movies`, built
for and served at `/movies/`. It talks to the core only through the platform SDK, and to the
media server's own routes with the session's token (ADR 0010).

### No sign-in of its own (D52)

- `/movies` opens the origin's shared IndexedDB store, which now lives in
  `packages/ui/src/lib/browser-session.ts` and serves the account client too. `MoviesSession` in
  `apps/web-movies/src/session/session.tsx` runs the platform client over it.
- It follows sign-in, renewal, switching, and sign-out across tabs through that store, as the
  account client does.
- A browser with no session, or whose session ends in any tab, goes to `/`. There the account
  client shows sign-in, or a shared device's picker.
- Switching person is signing out, then signing in at `/` (D52). The movies client has no sign-in
  page and no picker.
- The sign-in, welcome, setup, invite, device, and profile pages, and the admin pages for users,
  devices, and API keys, are deleted from the movies client. The account client has their
  replacements.
- In development, the movies Vite server serves `/movies/` and proxies every other path,
  WebSockets included, to the account client's dev server at `ACCOUNT_DEV_URL`. Development is
  then one origin too, and both clients share one store.

### Shared and movies-only UI

The plan asked for this split to be read from the `[movies]` Paper file. Paper Desktop was not
running during the cutover, so **the split was not read from Paper**. It moves only code that both
clients duplicated, and it changes no screen's look. Whether Paper agrees stays open
(`docs/architecture.md`, "Open").

These modules moved into `packages/ui`:

| Module                   | Holds                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `lib/failure`            | `describeFailure`, `isFailure`, and `toastFailure` for an expected failure |
| `lib/browser-session`    | the browser's one session store                                            |
| `lib/pages`              | paging through a paginated core query                                      |
| `components/page-header` | a settings screen's heading: breadcrumb, title, facts, and actions         |

Each client keeps its own shell, routes, screens, and styling. The movies client keeps Home, Movies,
Shows, titles, people, collections, genres, search, My List, the player, its Preferences, and its
admin pages. The account client keeps sign-in, the picker, invites, device approval, reset links,
account settings, and its admin.

### Settings and admin (D57)

- The movies client's settings are only Preferences, the theme this browser keeps, and a link to
  the account client's settings. Preferences that follow the person, such as subtitles and audio
  language, are set there.
- The movies client keeps the admin pages for movies content: Libraries, a library's page, a
  title's match page, and the Jellyfin and Plex importer. They need `movies:edit`, and the
  importer needs an owner or an admin.
- The server status and backups pages moved to the account client's admin, since they are the
  server's and not movies'.

### Left for p4-movies-parity (D62)

The core lacks some data that old movies' admin pages showed. The cutover ports the pages without
them, and the parity unit `p4-movies-parity` brings them back before the release:

- a library's file list and its filters, and a file's summary;
- the match status on a library's title rows;
- the jobs list, and canceling a scan or an import from it;
- a scan's start time and message;
- a backup job's state on the backups page.

The library page's "Scan now" asks for a full scan, which reads every file again, as old movies'
did: `core.libraries.scan` takes `mode: "full"`, carried in the scan job's payload to the server's
scanner. A full request joins a scan already queued or running, whatever its mode, as before.

## The movies iOS app as built (amended 2026-11-11)

`p4-mobile-movies` moved `apps/mobile` to `apps/mobile-movies`, the package `@media/mobile-movies`,
on the platform SDK. What every [media] iOS app shares lives in `packages/mobile-core`: the server
connection, the keychains, sign-in, and device enrollment.

### Connecting

People type the server's address. `@media/mobile-core/server` checks `/api/health`, then reads
`convexUrl` and `moviesUrl` from `/api/client-config` (ADR 0027): the core to run the platform
client on, and the movies web client, which a shared title link opens as `<moviesUrl>/title/<id>`.
Every sign-in goes to the media server's sign-in boundary, `signInUrlFor` the server's address
(ADR 0007).

### What the keychains hold (D48)

| Keychain group                         | Key                      | Holds                                                             |
| -------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| shared, `<Team ID>.dev.lmdevv.media`   | `media.phone`            | the server's address, the person's user id, and the grant         |
| the app's own, `<Team ID>.<bundle id>` | `media.server`           | the connection: the server, the core, and `moviesUrl`             |
| the app's own                          | `media.session.<server>` | the platform client's session tokens                              |
| the app's own                          | `media.app.<server>`     | the app's device code, who it last signed in as, and its D59 mark |
| the app's own                          | `movies.*`               | the app's local preferences                                       |

- Every app lists its own group first and the shared group second in its
  `keychain-access-groups` entitlement, and `app.json` names the Team ID (`ios.appleTeamId`), from
  which the app forms both names at run time (`groupsFor` in `@media/mobile-core/keychains`).
- Every keychain read, write, and delete names its group. iOS puts an item written without one in
  the first group the entitlement lists, so an unnamed write could land in the shared group, where
  the phone's other apps would read a session. Listing the own group first is a second guard.
- The records sign-in's safety depends on, the D59 mark, the person, and the grant, are written
  durably: a write the keychain refuses, as while the device is locked, throws and holds nothing,
  so the sign-in stops and the password prompt stays. Only records whose loss is harmless, the
  connection and the app's local preferences, fall back to memory for the launch.
- A build that cannot write the group, such as one without a team, keeps the shared record in the
  app's own keychain. It then works alone: nothing reaches the phone's other apps.
- An app with no connection of its own, whose shared keychain names a server, connects there on
  its first launch without asking.

### Signing in

- **The D59 mark.** Before any call that can open a session, the app sets `opened` in its own
  record. A launch that finds it set, or a person recorded, asks for the password and never
  exchanges the grant. So every state a crash can leave from the first write on, mid sign-in or
  mid exchange, asks for the password (`@media/mobile-core/sign-in.test.ts`, "a crash part way
  through a sign-in", starts a launch from the state after each write).
- **A password, an owner setup, or an invite** opens a session. The app enrolls its own device
  with the device code it keeps and records who signed in, then issues the phone's grant with
  `core.devices.deviceGrants.issue`, handing over the grant the shared keychain holds for this
  server. A grant of the same person is confirmed. Another person's is revoked, with every session
  it minted (D64). The grant is the last thing written, to the shared keychain, once every call
  has succeeded.
- **A device code** that someone approves opens a session that may not issue a grant (ADR 0006),
  so the app only enrolls. The shared keychain keeps whatever grant it held, and the phone's next
  password sign-in confirms or revokes it.
- **First launch.** An app that opens signed out and has never begun a sign-in on this server sets
  its mark, exchanges the shared grant for a session of its own (`Credentials.Grant`), then enrolls
  as its own device.
- **D59.** Once the app has begun a sign-in on a server, it never exchanges the grant again. When
  its session ends, whether the core refused it or the person signed out, the app shows sign-in
  with the person's username filled in and asks for the password. The platform client first
  refreshes once on `Unauthenticated` (D51).
- If issuing or enrolling fails, the app signs the new session out again, so it is never left
  signed in without its grant or its device.
- The platform client reports signed in as soon as the session opens. The app keeps its sign-in
  screens until the grant and the device are done, so no screen runs on a session that has no
  device yet.
- **Signing out** ends only this app's session. The grant stays in the shared keychain for the
  phone's other apps, and the next person's password sign-in replaces it (D64). Switching person
  is signing out, then signing in (D12, D52). A kid signs in as their own user, and the core
  applies their restrictions.

### What moved where

- Browse, titles, my list, history, and search read `platform.movies.*`.
- The player takes one ticket per start from `movies.play.start` and reports with its
  `playbackId` (ADR 0011). It renews no token. It stops its server stream at once, with
  `Playback.stopNow`, when it is torn down, and when nobody watches or hears it while the app is
  away: in the background with no Picture in Picture and nothing playing (owner, 2026-11-11). A
  stream someone watches in Picture in Picture or hears as background audio keeps its transcode
  slot; it stops when Picture in Picture closes or playback pauses there. A start that answers
  while the app is in the background opens no stream until the app comes back. iOS sends the
  background event before it ends an app, so a paused player is stopped before a kill. The rules
  are `StreamLifecycle` in `apps/mobile-movies/src/lib/player/app-state.ts`.
- Downloads follow `core.downloads.list` and fetch through 15-minute download tickets (ADR 0019),
  and offline progress goes to `movies.play.reportOffline`.
- The audio and subtitle languages, autoplay, and the streaming and download quality are the core's
  settings, so the web clients show what the app set. The rest stay on the phone.
- Profiles, profile PINs, watch rooms, and together are deleted (D12, D62). Shared-device tiles,
  unlock codes, and approvals stay in the web account client.
- The owner screens for libraries, users, import, and backups moved onto the core in
  `p4-mobile-owner` (D56); see "The owner screens on the core" below.
- API Keys creates a key and shows its secret once to copy, revokes by ID the keys made on this
  phone since the app opened, and ends every key. The core has no query that lists a person's
  keys, so the screen lists only those it made; listing every key waits for a core query, a
  logged parity follow-up.
- Left out because the core has no data for them (D62): a person's own list of signed-in devices
  (the Devices screen lists the registry, for admins), and the email on the account screen
  (accounts have only a username).

### The owner screens on the core (amended 2026-11-11)

`p4-mobile-owner` moved the iOS owner screens onto the platform SDK, and the app no longer holds
the old movies SDK or a Convex client of its own. They open for an owner or an admin holding the
`admin` scope, as the server's library, user, import, and backup commands need.

- **Libraries** list the movies libraries the person manages (`core.libraries.list` at `manage`).
  A library is made with `core.libraries.create` as kind `movies`: the core keeps movies and
  shows in one kind and tells them apart by their files, so the form lost old movies' Movies and
  Shows choice. Renaming is `core.libraries.rename`; new folders are `core.libraries.setFolders`,
  which rescans. The library and scan screens read `core.libraries.get`, which keeps only the
  latest scan, so the list of recent scans became the latest scan's row. A cancel names the
  attempt the screen showed and says so when the scan had started over (`movedOn`). Counts the
  core hides from a restricted editor (`items`, the file summary) are left out, not shown as zero.
- **Files and matching** page `movies.files.list` with `usePages`, which loads a page the
  core asks to split as two. Fix Match searches TMDB through the media server
  (`metadata.searchCandidates`) and matches with `movies.metadata.match`.
- **Import** connects, previews, and starts through the media server (`imports.connect`,
  `imports.preview`, `imports.start`) and follows the run with `movies.imports.get`. The old app
  had no cancel, so this one has none either (D62).
- **Backups** page `core.server.backups.list`, show a backup in progress from
  `core.server.backups.active`, run one with `core.server.backups.run`, and restore through the
  media server.
- **Users and invites** are shared: their state lives in `@media/mobile-core/accounts` (roles, who
  may change whose role, library access from grants, the invite link) and
  `@media/mobile-core/use-accounts` (the household, pending invites, making and revoking an
  invite, saving a person), and each app draws them in its own look. The music app reuses them in
  `p5-mobile-music`. An invite is made by `core.accounts.invites.create`, which makes the code on
  the server and answers it once; the app shares `<server>/invite#<code>` and never sends a code
  back in a mutation. Library access follows grants for every role, since a core library is
  private until shared, admins included (ADR 0024). The page shows a person's own grant, which
  it gives at `view` and takes away (`core.permissions.grants.set` and `remove`), apart from what
  reaches them through the household or a group they are in, as the core's `levelOn` counts it:
  taking their own grant away reads `View, through Family`, never Not Allowed, while a group
  still reaches them. The maker's grant to manage shows as Manages and stays. The page keeps the
  grant's real level, view or edit, so it asks before taking away a grant another admin raised
  meanwhile. It reads the person's own groups with `core.permissions.groups.memberOf`, an admin
  query over their memberships, at most 16 (`GROUPS_PER_USER_MAX`), never every group's members.
- **Owner forms save only what the person edited** (`@media/mobile-core/edits`). A row on screen
  keeps following the core while someone edits it, so a form never compares its fields with the
  live row: each field keeps the value it had when the person began editing it, a save writes
  only fields changed from that value, and it asks before writing over a field another admin
  changed meanwhile. The library edit form, a person's page, and Fix Match work this way, so a
  rename never writes back folders moved meanwhile, and saving library access never sends back
  a role another admin changed.
- **Shared with every iOS app** besides the users and invites screens: paging over the core's lists
  (`@media/mobile-core/pages`), the failure lines (`@media/mobile-core/failure`), and saving
  edits (`@media/mobile-core/edits`).
- Left out because the core has no command for them (D62): disabling and enabling an account, and
  an email on an invite.
