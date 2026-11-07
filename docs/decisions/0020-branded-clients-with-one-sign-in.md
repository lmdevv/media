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

One origin's `localStorage` holds every client's sign-in state. `session/origin.ts` names every key
and is their only writer, except the session keys, which only the SDK writes.

| Key                                 | Holds                                          |
| ----------------------------------- | ---------------------------------------------- |
| `media.device`                      | this browser's device code, `dv_<id>.<secret>` |
| `media.active`                      | the slot every client on the origin acts as    |
| `media.person.<userId>`             | the slot that holds that person's session      |
| `media.session.<slotId>`            | the SDK's session for one sign-in              |
| `media.session.<slotId>:<session>…` | that session's tokens and revocation (below)   |

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

- Every tab and every client on the origin reads the same keys. A switch, a sign-in, or a sign-out
  in one tab reaches the others through `storage` events. A session store can now announce changes
  (`KeyValueStore.subscribe` in the SDK), and the SDK's session follows what another tab wrote:
  renewed tokens of the same session, another person's sign-in, or a sign-out. So a background
  tab never spends a refresh token another tab already rotated, which Convex Auth would treat as
  reuse.
- D52 asks each client to mint its own session. The core cannot do that today, and doing it would
  break ADR 0006. The core keeps one session per person per device and one slot per shared device,
  so a second session minted for `/movies` would end the account client's session on the same
  device. The core also has no command that mints a session from another. So clients on one origin
  share each person's session and each runs its own SDK client over it. `/movies` and `/music`
  read `media.active` and never sign in themselves. If each client must still show as its own
  device, the core needs a grant exchange like D48's, and ADR 0006's one session per device must
  become one per client per device.

### A sign-out holds across tabs

`localStorage` has no atomic compare-and-set. Another tab's `storage` event arrives later, as its
own task, and tabs in separate processes read their own copy of the store, which catches up only
with that event. So no shared value that several tabs rewrite can be race-free. The core is the
authority instead: a sign-out ends the session on the server, the server then refuses its
refresh token and its calls, and the browser only has to make every tab stop using it.

- **One writer per key.** A store that can announce other clients' writes (`subscribe`) gets this
  layout under its key `K`. A store without `subscribe`, such as old movies' and the iOS app's,
  keeps the session under `K` alone, as before.
  - `K` names the current session (the token's `sub`). Only a sign-in writes it.
  - `K:<session>` holds that session's tokens. A sign-in creates it. A renewal of that session
    replaces it, only while it still holds the tokens the renewal started from.
  - `K:<session>:revoked` is written once when the session signs out, and never changes.
  - `K:<session>:confirmed` is written once when the server confirms the sign-out, which also
    removes `K:<session>`.
- **Reads change nothing.** A session with a revocation loads as none. No read deletes or rewrites
  a key, so a later sign-in is never lost to what an earlier read found.
- **Signing out** writes the revocation first and shows signed out at once, even if the server
  call fails. The client then asks the core to end the session, and on failure retries in the
  background, starting after a second and backing off to every 30 seconds, until the core confirms.
- **Only the core's revoke confirms.** `core.auth.sessions.revoke` takes any refresh token the
  session ever had, deletes the session and all its refresh tokens, and answers `confirmed` whether
  or not it had already ended. Convex Auth keeps a rotated or invalidated token's row until the
  session ends, so an old token still proves the session. A refresh that comes back empty proves
  nothing: Convex Auth refuses a token spent outside its reuse window but keeps the session alive.
  So a refused refresh is treated as a sign-out, and the session is revoked like any other. The
  command needs no session, because the refresh token is the proof. It cannot end a session whose
  token it was not given. ADR 0006's refusal of API keys concerns a caller acting with a key, and
  this command has no caller.
- **Storage that fails, fails closed.** When the revocation or the pending record cannot be
  written, as in a full `localStorage`, the session's tokens are removed first, which frees space,
  and the records are tried again. The retry stays alive in memory and writes the records again on
  every attempt. A revocation check that cannot read the store counts as revoked, and no token
  leaves the client unchecked, the in-memory fallback included.
- **A pending sign-out belongs to the browser, not to a slot.** Signing out also writes
  `media.signOut:<session>` with the session's tokens and the key it was signed in under. It sits
  outside every session key, so forgetting a slot or disposing that slot's client keeps it.
  - Every client takes over every pending sign-out when it starts and whenever another tab writes
    one, and retries it until the server confirms. Confirming deletes the record.
  - The record serves only to end the session on the server. No read that loads a session looks
    there, so nothing signs in or calls with it, and the session's own revocation keeps it out of
    every slot.
- **Every token passes a check.** A client checks for a revocation of its session before it hands
  any token to a caller, and again after it writes a renewal. A client that finds one drops the
  session at once and ends it on the server the same way, after a second's wait, so the client that
  signed out usually confirms it first and the others send nothing.
- **What this guarantees.** Once the server confirms a sign-out, no credential of that session
  works anywhere. Before that, every tab stops using it as soon as it reads storage, which it does
  before every token it uses. The window left is a tab that has not yet read storage. While the
  server cannot be reached, nothing reaches it either.
- A refresh the server refuses becomes a revocation, unless the store shows that another tab
  renewed the session first. A tab reading a stale copy can still revoke a session another tab
  just renewed. That tab then signs out and the person signs in again. This never keeps a session
  alive.
- **Sweeping.** Each client sweeps the store's revocation records when it starts. It deletes a
  record, with that session's leftover tokens and pending sign-out, 31 days after the sign-out:
  the core's 30-day limit on a session and on an unused refresh token, plus a day. Past 64
  confirmed revocations it also drops the oldest confirmed ones, whose sessions the core already
  ended. It never deletes a key that names the current session, or a session revoked less than 31
  days ago that the core has not confirmed. A session id revoked in a
  store does not load there again until its record is swept. Every sign-in in the account client starts a new session, so
  this only matters for an API key, which reuses its session. When the account client forgets a
  slot or a person moves to a new one, it removes that slot's token keys and keeps its
  revocations.
- None of this needs a secure context. Over plain HTTP on a LAN or tailnet address, which installs
  support, `navigator.locks`, `crypto.randomUUID`, `crypto.subtle`, and `navigator.clipboard` are
  missing. The client uses none of them unguarded. Slot ids come from `randomUuid` and copying from
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
- A BroadcastChannel beside `storage` events. The events already reach every other tab for exactly
  the keys that change.
- Web Locks around each write. They exist only in secure contexts, and a lock does not make
  another process's copy of `localStorage` current.
- A shared list of ended sessions. Two tabs that sign out at once each rewrite the list without
  the other's entry, and a read that cleans up after it can delete a newer sign-in.
- Secrets in the path or the query. Both reach the server's request log and any proxy in the
  first request, and stay in history until the link expires.
