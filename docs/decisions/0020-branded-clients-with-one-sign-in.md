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

| Key                      | Holds                                          |
| ------------------------ | ---------------------------------------------- |
| `media.device`           | this browser's device code, `dv_<id>.<secret>` |
| `media.active`           | the slot every client on the origin acts as    |
| `media.person.<userId>`  | the slot that holds that person's session      |
| `media.session.<slotId>` | the SDK's tokens for one sign-in               |

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

Another tab's `storage` event arrives later, as its own task. A refresh that finishes in the
meantime must not write its renewed tokens over a sign-out it has not heard of yet.

- `TokenStorage.replace(expected, next)` writes only while the store still holds `expected`. The
  SDK commits every refresh this way: renewed tokens, or a clear after the server refused the
  refresh token. Sign-in and sign-out still write without checking, because they replace
  whatever was there.
- When the store holds something else, the refresh lost to another writer, and the client adopts
  what the store holds. If the store holds no session or another session, the client ends the
  session it just renewed on the server. That also ends it when the tab that signed out could not
  reach the server. If the store holds the same session with other tokens, another tab renewed it
  first, and the client keeps those.
- `KeyValueStore.exclusive` runs each session write, the check included, under a lock. The
  account client passes `navigator.locks`, so tabs in separate processes cannot interleave a
  check and a write. Web Locks exist only in secure contexts. Over plain HTTP on a LAN address the
  client has no lock, and the check and write run in one task, which no other tab in the same
  process can split. A tab in another process can still write between them, a window of one read
  and one write.
- A sign-out whose server call fails still clears this browser, then logs
  `Auth.serverSignOutFailed`.

### Rejected

- Keeping the people of a browser in the SDK. The CLI and the iOS apps hold one person each, so
  the SDK would carry a web-only policy and its own storage format.
- One shared session key with the other people's tokens stashed elsewhere and swapped in. The
  stash goes stale at the first refresh, and Convex Auth then ends the session as reused.
- A BroadcastChannel beside `storage` events. The events already reach every other tab for exactly
  the keys that change.
- A separate generation counter or sign-out marker beside each session key. The tokens already
  identify every write, since each sign-in and each refresh issues new ones, so comparing them is
  the check.
