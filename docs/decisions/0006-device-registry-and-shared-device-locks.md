# 0006. Register every device and lock adult tiles on shared devices

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the registry and locks as built,
  2026-11-07 with the phase 3 review fixes, 2026-11-07 with one session per device (D52), and
  2026-11-09 with device grants (D48, D59), and 2026-11-10 with one person per phone (D64).
- Decisions: D18, D19, D35, D40, D47, D48, D52, D59, D64

## Context

Music has a device registry. Movies identifies devices by an id the client sends and guards
profiles with PINs that each session unlocks. With profiles gone (ADR 0003), the picker shows
users, and a family TV or a shared iPad needs a way to keep a kid from opening an adult's tile.

## Decision

- **One device registry**, music's model. A device is personal or shared.
- **One session per device.** A device holds one session at a time, whoever's. Switching person
  on a device signs the first person out there (D52).
- **The picker on a personal device** shows only the user signed in on that device.
- **A shared device** is one an admin marks shared. Its picker lists every household user who opted
  in to shared devices.
- **Locks.**
  - With no kids on the device and no admin rule, tiles open freely.
  - An admin can require a lock for any user.
  - When a kid is on a shared device, every non-kid tile on that device locks. This cannot be
    turned off.
- **Opening a locked tile.** Any one of these opens it:
  - typing the user's password,
  - an optional short unlock code,
  - approval from another device where that user is signed in, such as a phone, laptop, or iPad.
- **The unlock code** works only on shared-device lock screens. It is never a sign-in credential. It
  locks after 5 wrong tries.
- **Leaving a kid tile** needs an adult's approval.
- **Approval prompts** in v1 reach devices where an app is open. Push notifications are in the
  backlog.

## Consequences

- Each app instance registers as its own device. On iOS, each app appears as its own device even
  with one shared sign-in (ADR 0020).
- The device registry is the anchor for per-device settings, downloads, and Connect targets (ADR
  0018 and ADR 0019).
- An adult on a shared device with a kid present always proves who they are before their tile
  opens.
- An approval arrives only where an app is open, so an adult with every app closed types the
  password or the unlock code instead.

## Alternatives rejected

- Per-profile PINs, as movies has today. Profiles are gone (ADR 0003).
- An unlock code that also signs in. The code opens a lock screen and nothing else.
- Push notifications for approvals in v1. They are in the backlog.

## Edge cases settled

- A user who did not opt in to shared devices never appears on a shared device's picker.
- An admin cannot turn off the kid lock on a shared device.
- After 5 wrong tries, the unlock code locks on that device. It unlocks again as "Unlock codes"
  below says.
- A kid cannot leave their own tile alone. An adult approves.
- A personal device never lists a user who is not signed in on it.

## Devices and locks as built (amended 2026-11-04)

The registry, the picker, tiles, unlock codes, and approvals are in
`packages/platform/convex/core/devices/`. The `tile` sign-in provider is in
`convex/core/auth/tiles.ts`, and the rules are in `convex/core/permissions/policy.ts`.

### The registry

- A device is a `devices` row plus a device code, `dv_<deviceId>.<secret>`, that the app keeps.
  The core stores the SHA-256 of the secret. A device is not a principal, because Convex Auth gives
  every session a user.
- An app registers after it signs in, with `core.devices.registry.enroll`. When it passes its
  stored code, the new session joins the same device. A lost or unknown code registers a new
  device.
- A device's name is shown to other people: in the picker, approvals, and Connect. The name
  `enroll` and `core.devices.deviceGrants.issue` take, and a device code's client name, follow the
  rule guest names follow (ADR 0007, `printableName` in `core/lib/names.ts`): NFKC form, trimmed,
  no control, bidirectional, private-use, or unassigned character, at least one visible one, and
  at most 64 code points. The app builds the name and sends it once, at enrollment, so one that
  breaks the rule is refused with `invalid_args`. A Cast receiver's name comes in every report
  instead, so it is kept as null (ADR 0018).
- A device holds one session. Binding a session to it, by enrolling on a personal device or by
  opening a tile on a shared one, ends the session it held, whoever's. Each bind takes the next
  number on the device's count, `devices.joins`, which goes on across mode changes. `enroll`
  answers it as `joinSequence`, and `core.auth.sessions.current` names the device and number of a
  bound session, as a tile's. Of two sign-ins that raced, the higher number is the one still live,
  and a client keeps that one (ADR 0020).
- `authSessions.device` records the device and its `generation` when the session joined it.
  `liveSession` treats a session as ended once its device is gone or has another generation. So
  an admin's mode change (`core.devices.registry.setMode`) or removal
  (`core.devices.registry.remove`) signs everyone on the device out with one write, and a
  scheduled job deletes the dead rows afterwards.
- A personal device's picker lists the person with the live session on it. A shared device's picker
  lists everyone who opted in (`users.sharedDevices`), by username, at most 50 people.
  `core.devices.picker.show` takes the device code, because a shared device at its picker has no
  session. On an idle dev stack with 20 people listed, it answered in 8 to 10 ms at the median
  over 200 uncached calls in five runs, and read 32 documents a call.

### Tiles

- Opening a tile is a sign-in through the `tile` provider, with the device code, the person, and
  a proof when the tile is locked. The session it opens has the kind `tile`. It holds the person's
  content scopes and never `account` or `admin`, so nothing on a shared device can change an
  account, register a device, or approve itself. It lasts 12 hours, so a TV is back at its
  picker by the next day.
- A shared device has one slot. Opening a tile puts the new session in the slot and ends the
  session that was there. A tile session is live only while it fills the slot and its person is
  still listed, so opting out signs that person out of every shared device.
- Adults opt themselves in and out with `core.devices.tiles.setListed`. An admin lists or unlists
  a kid, and a kid cannot change it. A kid who unlisted themselves would unlock every adult tile.

### Locks

Opt-in is global, so every shared device lists the same people. "A kid on a shared device" means
a listed kid, and while one is listed, every adult tile on every shared device locks. A lock is
never stored. `lockOf` derives it from three reasons:

| Reason             | Applies when                                                               | Opens with                        |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------- |
| `admin-rule`       | an admin requires the person's tile to lock (`core.devices.tiles.setLock`) | the person, or an adult for a kid |
| `kid-listed`       | the shared devices list a kid, and the person is not a kid                 | the person only                   |
| `kid-holds-device` | another kid's tile was the last one opened on this device                  | an adult                          |

- A proof is a password or an unlock code typed on the device, or an approval. An adult is a
  person with no restrictions who is listed or is an admin. No adult opens another adult's tile.
- The kid's hold lives in the device's slot, not in the kid's session, so the kid signing out does
  not release it. An adult's proof typed on the device, or an adult's `leave` approval, releases
  it. A kid who loses their restrictions holds nothing.
- An admin cannot lift the lock a listed kid causes. `setLock` with `locked: false` fails
  `forbidden` while a kid is listed, even for a person with no admin rule.
- A lock decides when a tile opens. A tile that is open when a kid becomes listed stays open until
  someone leaves it or its 12 hours end, as a restriction change ends no session (ADR 0005).

### Unlock codes

- `core.devices.unlockCodes.set` takes 4 to 7 digits and stores a Scrypt hash, which the core
  compares in constant time. The `password` provider never reads it, and the `tile` provider
  refuses it on a personal device.
- An unlock code is one digit shorter than the shortest password, which is 8 characters. So no
  value is ever both a person's unlock code and their password. This holds on every path that
  sets either one, including a password change, a reset link, a host reset, an invite, and an
  admin-made user, and at every moment, with no comparison to race. The code's longest length is
  derived from the password's shortest, so raising one moves the other.
- A password's length counts the code points of its NFKC form, because that is the string Scrypt
  hashes and compares. `𝟕𝟑𝟗𝟏𝟒𝟒𝟖` in mathematical bold is 14 UTF-16 units but hashes as `7391448`,
  so it counts as 7 characters and is refused. `checkNewPassword` in `core/lib/passwords.ts`
  applies the rule, 8 to 256 characters, on that form for every path that sets a password.
- A password typed to sign in, open a tile, or confirm a password change is refused only when it is
  over 2,048 UTF-16 units, before it is normalized, since NFKC can make a string 18 times longer.
  No password is typed longer: NFKC joins at most 4 code points into one. A password set when the
  rule counted 256 UTF-16 units also fits, so it still signs in.
- An unlock code is ASCII digits only. NFKC leaves them as they are, so the code the core checks
  is the string it hashes, on `set` and in the `tile` provider alike.
- The `tile` provider counts a wrong try per person and device (`unlockStrikes`) before it checks
  the digits, so tries made at once never pass 5. Each person also has 20 code tries an hour
  across all devices.
- After 5 wrong tries in a row, the code is off on that device. There is no timer. It works again
  on that device after one of these:
  - the person types their password there,
  - an approval from another device where the person is signed in opens the tile there,
  - an admin resets it with `core.devices.unlockCodes.reset`.
- A right code also clears the count, so the count is of wrong tries in a row. It clears it, and
  gives back its hourly try, in its own transaction before the tile opens, so a right code costs
  nothing even when the tile cannot open after all, as when a kid takes the device meanwhile. A
  new code starts at zero on every device.

### Approvals

- A shared device asks with `core.devices.approvals.request`. `open` asks a person to open their
  locked tile. `leave` asks any adult to let the kid who holds the device leave. A device keeps one
  live approval, for 2 minutes.
- `core.devices.approvals.pending` is the prompt list an open app shows. Answering needs the
  `account` scope, which a tile session never holds, so every approval comes from another device.
  API keys cannot approve. The list reads only waiting approvals, by index, so answered ones never
  crowd a prompt out.
- An approved `open` lets the device sign in with that approval. A retry gets the same session
  while it fills the slot, so a lost answer costs only a retry. An approved `leave` empties the
  slot at once.

### Control

`can(principal, "control", device)` holds the Connect rule from ADR 0018. A person controls
their own personal device, which means one with their live session on it, and a shared device
that lists them. They never control another person's personal device. Connect uses the rule, and
ADR 0018 records how it is built.

### Actions added to `can`

| Action                | On       | Needs                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `open`                | tile     | the tile's own listed person, and for a locked tile a proof every reason accepts |
| `lock`                | tile     | `admin`, on anyone but a guest                                                   |
| `unlock`              | tile     | `admin`, and no listed kid locking the tile                                      |
| `answer`              | approval | `account`; `open` by the tile's person, `leave` by an adult                      |
| `control`, `report`   | device   | as built in ADR 0018: the person's own device or a shared device listing them    |
| `listOnSharedDevices` | account  | oneself with `account` and no restrictions; otherwise `admin`, on a kid          |
| `resetUnlockCode`     | account  | `admin`, on anyone in the household                                              |
| `manageDevices`       | server   | `admin`                                                                          |

### Edge cases settled in the build

- A device code from a device that became shared registers nothing: `enroll` fails `conflict`,
  and the app opens tiles from the picker instead.
- An approval made before its approver signed out everywhere no longer opens anything, and the
  device's next `request` makes a new one instead of handing it back.
- A person the shared devices do not list has no tile there: opening one fails `not_found` with
  "No such tile on this device", not the lock screen's message.
- Listing a person again brings back their tile session if it still fills a slot and has not
  expired. The session was theirs before they unlisted.
- A device's approval and strikes go when it stops being shared or is removed.

Rejected in this build:

- A device as its own principal, a `users` row with a session that switches whom it acts as. Every
  caller check would need an actor and a subject, and Convex Auth fixes the user in the token.
- Stored locks per device and person. Each opt-in, restriction, and admin rule would have to
  rewrite every shared device's rows.
- Ending tile sessions when a kid becomes listed. That fans out over every shared device, and
  ADR 0005 already lets a restriction change end no session.
- A timer that turns an unlock code back on. D47 names the password, an approval, and an admin.
- Refusing an unlock code that matches the password. The check read the password in one
  transaction and stored the code in another, so a password change in between could still make
  them equal. Changing or resetting the password to the code's digits never checked the code at
  all, and the code then signed in as the password.
- Ending the unlock code whenever the password changes. It keeps the two from being equal, but a
  person can still choose the old code's digits as the new password. The household knows those
  digits, so they would sign in.
- Counting a password's UTF-16 units as typed. Scrypt hashes the NFKC form, so a password of 7
  look-alike digits passed as 14 units and then signed in with the 7-digit code they hash as.
- Refusing a typed password over 256 NFKC characters at sign-in. A password set under the 256-unit
  rule can normalize longer, such as 100 `ﬃ` ligatures, and its person could no longer sign in.

## Device grants as built (amended 2026-11-09)

A phone or tablet runs several of the person's apps, and each app is its own device here (ADR 0020).
D48 gives the phone one grant for the person. Its shared keychain keeps the grant, and each app
exchanges it for a session of the app's own. The code is in
`packages/platform/convex/core/devices/deviceGrants.ts`. The plan named the module `grants.ts`, but
the command generator refuses that name, because `media auth grants` is already the CLI path of
`core.permissions.grants`. The CLI commands are `media auth device-grants issue`, `list`, and
`revoke`.

### The grant

- A grant is a `deviceGrants` row and a code, `dg_<grantId>.<secret>`, that the phone keeps. The
  row holds the person, a name such as "Aiko's iPhone", the SHA-256 of the secret, and a
  generation. The core never stores the code and never logs it.
- The generation is the person's `sessionGeneration` when the grant was issued or last confirmed.
  A grant mints sessions only while the two are equal.
- A grant has no expiry. Like a device code, it lasts until it is revoked or its person signs out
  everywhere.

### Issuing

- `core.devices.deviceGrants.issue` takes the device's name and, when the keychain holds one, the
  stored grant. Only a session that a password opened may issue, so an exchanged session, an API
  key, a device sign-in, and a tile cannot. Otherwise a credential could mint a grant that outlives
  its own revocation, and sessions from that grant would outlive it too.
- If the stored grant is the caller's own, issuing confirms it. The answer is the same grant, and
  its generation becomes the person's current one, so a password typed on the phone brings back a
  grant that signing out everywhere had stopped. A tampered, malformed, unknown, or revoked value,
  or none, gets a new grant and changes nothing else. A person may issue 20 grants an hour.
- D64: a phone holds one person, as a browser does (D52). If the stored grant is another person's,
  with a matching secret, issuing revokes it first: the grant is deleted and every session it
  issued or minted ends, exactly as `revoke` does, in the same transaction that inserts the
  caller's new grant. The answer is a new grant either way, so it never says whether the phone held
  someone's grant or whose. Only a password session can do this, since it is the issue rule; an
  exchanged session, an API key, a device sign-in, a tile, or a guest is refused before the stored
  grant is read. Holding the code is the authority, as it is for the exchange: the phone that
  keeps it could already sign that person's apps in, so the core needs no other check. A refused
  issue, such as the hourly limit, revokes nothing.
- Issuing puts the caller's session in the grant's family (`authSessions.grant`), moving it out of
  any family it was in. Revoking the grant then signs out the app that issued it too. A session
  that issues from a laptop joins that grant's family the same way, so issue only on the phone.

### The exchange

- The `grant` sign-in provider takes the user id from the keychain and the grant. It opens a
  session of kind `grant`. That session holds the person's role scopes, as a password session does,
  and carries the person's `sessionGeneration`.
- The app then enrolls with its own device code through `core.devices.registry.enroll`. So each app
  shows as its own device, and an app that exchanges again replaces its earlier session on its
  device, because a device holds one session. The provider cannot hand back a new device code,
  so enrolling stays the one place that registers a device.
- Every refused exchange gets the same `unauthenticated` message, "This device grant does not work;
  sign in with your password". That covers a malformed grant, an unknown one, a tampered one,
  another person's, a revoked one, and a stopped one.
- An exchange is a hash, an index read, and an insert, with no Scrypt. On an idle dev stack, two
  runs of 100 sign-in round trips each, interleaved in blocks of 10, had medians of 39 and 42 ms
  for the exchange, against 165 and 175 ms for trunk's password sign-in.

### Ending sessions

| Event                                                              | Ends                                     | The grant                    |
| ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------- |
| `core.devices.deviceGrants.revoke`                                 | every session in the grant's family      | deleted                      |
| Another person's password sign-in issuing with the grant (D64)     | every session in the grant's family      | deleted                      |
| `core.auth.sessions.end`, or a later join on the app's device      | that one app's session                   | stays and still mints        |
| `endAll`, a password change or reset, a role change taking a scope | every session of the person's generation | stays, stopped until confirm |
| A device mode change or removal                                    | the sessions on that device              | stays and still mints        |

- Revoking deletes the grant and its family in one transaction. A grant keeps at most 16 sessions
  (`GRANT_SESSIONS_MAX`), so the delete always fits one call. A session past that ends the oldest
  session on no device first, which an app that exchanged and never enrolled left behind, so an
  app that keeps exchanging signs no other app out. As with an API key, the refresh tokens are left
  to expire and be swept.
- A session in the family can still make an API key or approve a device sign-in, as a password
  session can. Those credentials are their own, and revoking the grant leaves them, just as ending
  a password session leaves the keys it made. Signing out everywhere (`core.auth.sessions.endAll`)
  ends the device sign-ins, since they carry the person's `sessionGeneration`, but leaves API keys
  and their sessions, which follow `keyGeneration`. `core.auth.apiKeys.endAll`, a password reset,
  and a role change that takes a scope away end the keys.
- D59: an app whose session the core refuses while the keychain still holds a grant asks for the
  password. It does not exchange again. The password sign-in then confirms the stored grant. An
  app exchanges silently only when it has no session of its own yet, as on first launch. The core
  cannot tell a refused app from a new one, so this rule lives in the app
  (`@media/mobile-core`, p4-mobile-movies). The core's own guarantees are that a revoked grant
  never mints again, and that a stopped one mints only after a password sign-in on the phone.

### Listing

`core.devices.deviceGrants.list` shows the person's grants, newest first. Each row says whether
the grant still signs apps in and lists the devices that hold a live session from it. A grant costs
at most 33 reads, its row and each session with its device, so a page holds at most 29 grants.

### Actions added to `can`

| Action   | On          | Needs                                                              |
| -------- | ----------- | ------------------------------------------------------------------ |
| `issue`  | deviceGrant | the grant's own person, `account`, and a session a password opened |
| `list`   | deviceGrant | the grant's own person and `account`                               |
| `revoke` | deviceGrant | the grant's own person and `account`                               |

Another person's grant is `hidden`, admins included, as an API key is. The D64 switch decides `issue` for the
caller, not `revoke` on the other person's grant: holding that grant's code is what lets the
caller end it, and the caller still cannot list it or revoke it by id. An admin who must cut a
person off resets their password, which stops every grant they hold. Restricting a member into a
kid stops no grant, as it ends no session (ADR 0005); the restrictions apply on every call.

### Rejected

- One session shared by every app on the phone. Each app shows as its own device (ADR 0020).
- Letting any session with `account` issue. A grant issued from an exchanged session would let
  the phone's apps sign in again after their own grant was revoked.
- Reading the grant on every call to decide whether a session is live. Revoking deletes the family
  at once instead, as revoking an API key does, so a live call reads nothing more.
- Binding the device inside the exchange. The provider can return only tokens, so a new app could
  never learn its device code.
