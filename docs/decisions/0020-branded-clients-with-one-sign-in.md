# 0020. Ship a branded client per product on a shared base, with one sign-in

- Status: Accepted, 2026-11-03
- Decisions: D38, D39, D40

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
- Which credential the shared keychain holds, and what signing out of one app does to the other,
  is open until the movies port (`docs/architecture.md`, "Open").
- The exact split between shared and per-product UI is open until the port, and Paper decides it
  (`docs/architecture.md`, "Open").

## The account client on the web as built (amended 2026-11-06)

`apps/web-account` is the first web client on the core. It talks to the core only through the
platform SDK. Its session layer is `apps/web-account/src/session/`.

### What a browser holds

One origin's IndexedDB database `media` holds every client's sign-in state, in one object store
`kv` of string keys. `session/origin.ts` names the origin's keys, and the SDK's `layerShared`
names the session keys. `localStorage` holds nothing credential-bearing.

| Key                                | Holds                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `media.device`                     | this browser's device code, `dv_<id>.<secret>`                               |
| `media.active`                     | the slot every client on the origin acts as                                  |
| `media.person.<userId>`            | the slot that holds that person's session                                    |
| `media.session.<slotId>`           | the slot's session: its id, its person, and that person's sign-in generation |
| `media.session.<slotId>:<session>` | that session's tokens                                                        |
| `media.revoked:<session>`          | a sign-out, and the core's confirmation once it comes                        |
| `media.signOut:<session>`          | a sign-out the core has not confirmed, for any client                        |
| `media.generation:<userId>`        | the person's sign-in counter, raised by each sign-in                         |

- **A slot** is a random local name for one sign-in's tokens. A password, setup, invite, or reset
  sign-in starts before the client knows whose session it is, so the key cannot carry the
  person's id. Once the sign-in returns, the slot is promoted to that person. Tokens are never
  copied between keys, so each refresh token has one owner.
- **Several people on one personal browser.** The core keeps one session per person per device
  (ADR 0006), so each person signed in here has their own slot. The picker on `/` lists the
  people the core says are signed in on this device. Choosing one moves `media.active` to their
  slot and opens a new client on it, with no password. Add someone signs another person in on a
  fresh slot.
- **A shared browser.** When an admin makes the device shared, every session on it ends, and `/`
  shows the shared picker, whose tiles open through the core's `tile` provider
  (`Credentials.Tile` in the SDK). The device's one slot holds the open tile, and opening another
  tile replaces it.
- **Ended sessions stay stored** until someone signs in on their slot again, and only a device the
  core no longer knows makes the client forget its code. Another tab's new sign-in can reach this
  tab's storage before this tab's picker lists the person, so a picker that leaves someone out is
  no proof their session ended.
- **The screen** is one pure function of the server's answer, the session, the picker, and the
  route (`session/screen.ts`). Each route declares what it needs: nothing, a sign-in, an account
  session, or an admin. A tile session never has the `account` scope, so account pages tell it to
  use the person's own device.

### Clients on one origin (D52)

- Every tab and every client on the origin reads the same store. After a write commits, a
  `BroadcastChannel` tells the other tabs to read again; the message carries nothing, so it never
  carries authority. The SDK's session follows what another tab wrote: renewed tokens of the same
  session, another person's sign-in, or a sign-out. So a background tab never spends a refresh
  token another tab already rotated, which Convex Auth would treat as reuse.
- D52 asks each client to mint its own session. The core cannot do that today, and doing it would
  break ADR 0006. The core keeps one session per person per device and one slot per shared device,
  so a second session minted for `/movies` would end the account client's session on the same
  device. The core also has no command that mints a session from another. So clients on one origin
  share each person's session and each runs its own SDK client over it. `/movies` and `/music`
  read `media.active` and never sign in themselves. If each client must still show as its own
  device, the core needs a grant exchange like D48's, and ADR 0006's one session per device must
  become one per client per device.

### A sign-out holds across tabs

The core is the authority: a sign-out ends the session on the server, and the server then refuses
its refresh token and its calls. The browser has to make every tab stop using it, and never bring
it back. `localStorage` cannot do that: it has no atomic compare-and-write, Web Locks are missing
over plain HTTP, and every round of review found another interleaving. The shared state is
therefore in IndexedDB, whose readwrite transactions on one object store run one at a time across
every tab of the origin, and which works outside secure contexts.

- **Every change is one transaction** that reads what it decides on and writes in the same
  transaction, so no other tab's write lands between the check and the write.
  - A sign-in refuses a session that has a revocation, before it writes anything, and the client
    then counts as signed out. Otherwise it raises the person's sign-in generation and writes the
    tokens and the slot's session, person, and generation.
  - A renewal writes new tokens only while the stored tokens are still the ones the refresh
    started from and no revocation exists.
  - A sign-out writes the revocation and the pending sign-out and deletes the tokens. If that
    transaction fails, as when storage is full, nothing of it lands. A second transaction then
    deletes the tokens alone, which frees space. The client stays signed out, and its retry keeps
    writing the records again.
  - Every change names what it expects and does nothing if the store no longer matches. A promote
    goes ahead only while the slot holds that person's newest sign-in generation, so a sign-in
    another tab finished later keeps the person. A slot that lost that way is forgotten. The person's older slot goes too, unless another sign-in has taken it since. A forget
    names the slot and the session it signed out, and goes ahead only while the slot still holds
    that session, so a session another tab saved there since stays. It then deletes only the
    mappings and the active slot that still point at the slot.
  - The sweep deletes a revocation 31 days after the sign-out, past the core's 30-day limit on a
    session and an unused refresh token. It also drops the oldest confirmed revocations past 64.
- **Every token passes a transactional check.** Before a client hands out any token, the
  in-memory one included, it reads the session's state in a transaction. The token goes out only
  while the store holds that session's tokens and no revocation. A client that finds the session
  revoked or gone drops it at once. A read that fails counts as revoked.
- **Signing out** writes the revocation and shows signed out at once, even if the server call
  fails. Once the pending sign-out is stored, `signOut` returns and the client asks the core to end
  the session in the background. On failure it retries, backing off from a second to every 30
  seconds, until the core confirms. Any client that starts, or hears of a write, takes over every
  pending sign-out, even one whose slot was forgotten and whose client is gone. Confirming
  deletes the record. A store that keeps no pending sign-outs, such as the CLI's, waits for one
  attempt instead.
- **Only the core's revoke confirms.** `core.auth.sessions.revoke` takes any refresh token the
  session ever had, deletes the session and all its refresh tokens, and answers `confirmed`
  whether or not it had already ended. Convex Auth keeps a rotated or invalidated token's row
  until the session ends, so an old token still proves the session. A refresh that comes back
  empty proves nothing, so a refused refresh is treated as a sign-out and revoked like any other.
  The command needs no session, because the refresh token is the proof. It cannot end a session
  whose token it was not given. ADR 0006's refusal of API keys concerns a caller acting with a
  key, and this command has no caller.
- **The account client forgets the slot it signed out of**, which is its own client's slot. The
  forget transaction leaves a slot another tab signed the person in on meanwhile.
- **Without IndexedDB**, as in some private modes, or when it has not opened within five seconds,
  as when another tab blocks it, the browser keeps no sign-in and shows signed out. A sign-in then
  says to reload the page. It never falls back to `localStorage`. The CLI's and old movies' stores are unchanged: a
  store one client owns keeps the session under one key.
- **What this guarantees.** Once the core confirms a sign-out, no credential of that session works
  anywhere. Before that, every tab stops using it at its next token, which first reads the store
  in a transaction. No renewal can bring it back, because a renewal commits only over the exact
  tokens it started from. The window left is a request already sent with a token checked before
  the sign-out committed.
- A refresh the server refuses becomes a revocation, unless the store shows that another tab
  renewed the session first. That can sign out a tab whose own renewal was still in flight. The
  person signs in again, and it never keeps a session alive.
- None of this needs a secure context. IndexedDB and `BroadcastChannel` work over plain HTTP on a
  LAN or tailnet address, which installs support. Slot ids come from `randomUuid` and copying from
  `copyText` in `@media/ui/lib/secure-context`, which `apps/web` shares. The Playwright suite runs
  a second time against the host's non-loopback address over plain HTTP.

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

- Keeping the people of a browser in the SDK. The CLI and the iOS apps hold one person each, so
  the SDK would carry a web-only policy and its own storage format.
- One shared session key with the other people's tokens stashed elsewhere and swapped in. The
  stash goes stale at the first refresh, and Convex Auth then ends the session as reused.
- `storage` events as the notification. They fire only for `localStorage` writes, and the store
  makes none; a `BroadcastChannel` tells the other tabs instead.
- Web Locks around each write. They exist only in secure contexts, and a lock does not make
  another process's copy of `localStorage` current.
- A shared list of ended sessions. Two tabs that sign out at once each rewrite the list without
  the other's entry, and a read that cleans up after it can delete a newer sign-in.
- Any session state in `localStorage`. Four rounds of review each found a new interleaving, because
  nothing there checks and writes as one step. IndexedDB transactions do.
- Secrets in the path or the query. Both reach the server's request log and any proxy in the
  first request, and stay in history until the link expires.
