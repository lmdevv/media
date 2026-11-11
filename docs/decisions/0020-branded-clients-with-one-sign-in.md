# 0020. Ship a branded client per product on a shared base, with one sign-in

- Status: Accepted, 2026-11-03. Amended 2026-11-06 with the account client as built,
  2026-11-07 with one sign-in session per browser (D52), 2026-11-09 with what the iOS keychain
  holds (D48, D59), and 2026-11-10 with the movies client on the web as built (D52, D57, D62).
- Decisions: D38, D39, D40, D48, D52, D57, D59, D62

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
