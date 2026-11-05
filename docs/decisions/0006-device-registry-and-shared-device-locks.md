# 0006. Register every device and lock adult tiles on shared devices

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the registry and locks as built.
- Decisions: D18, D19, D35, D47

## Context

Music has a device registry. Movies identifies devices by an id the client sends and guards
profiles with PINs that each session unlocks. With profiles gone (ADR 0003), the picker shows
users, and a family TV or a shared iPad needs a way to keep a kid from opening an adult's tile.

## Decision

- **One device registry**, music's model. A device is personal or shared.
- **The picker on a personal device** shows only the users signed in on that device.
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
  device. Each person keeps one session per device, and a personal device holds at most 16 people.
- `authSessions.device` records the device and its `generation` when the session joined it.
  `liveSession` treats a session as ended once its device is gone or has another generation. So
  an admin's mode change (`core.devices.registry.setMode`) or removal
  (`core.devices.registry.remove`) signs everyone on the device out with one write, and a
  scheduled job deletes the dead rows afterwards.
- A personal device's picker lists the people with a live session on it. A shared device's picker
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
  so it counts as 7 characters and is refused. Every password rule is checked in
  `core/lib/passwords.ts` on that form: 8 to 256 characters for a new password, and at most 256
  for one typed to sign in, open a tile, or confirm a password change, so any password that can be
  set can also be typed.
  Typed input over 2,048 UTF-16 units is refused before it is normalized. NFKC can make a string
  18 times longer, and it joins at most 4 code points into one, so no 256-character password is
  typed longer.
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
- A right code also clears the count, so the count is of wrong tries in a row. A new code starts
  at zero on every device.

### Approvals

- A shared device asks with `core.devices.approvals.request`. `open` asks a person to open their
  locked tile. `leave` asks any adult to let the kid who holds the device leave. A device keeps one
  live approval, for 2 minutes.
- `core.devices.approvals.pending` is the prompt list an open app shows. Answering needs the
  `account` scope, which a tile session never holds, so every approval comes from another device.
  API keys cannot approve.
- An approved `open` lets the device sign in with that approval. A retry gets the same session
  while it fills the slot, so a lost answer costs only a retry. An approved `leave` empties the
  slot at once.

### Control

`can(principal, "control", device)` holds the Connect rule from ADR 0018 for later units. A person
controls their own personal device, which means one with their live session on it, and a shared
device that lists them. They never control another person's personal device. Guests control
nothing until guest sessions exist (ADR 0007). No command uses the rule yet.

### Actions added to `can`

| Action                | On       | Needs                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------- |
| `open`                | tile     | the tile's own listed person, and for a locked tile a proof every reason accepts |
| `lock`                | tile     | `admin`, on anyone but a guest                                                   |
| `unlock`              | tile     | `admin`, and no listed kid locking the tile                                      |
| `answer`              | approval | `account`; `open` by the tile's person, `leave` by an adult                      |
| `control`             | device   | a personal device the person is signed in on, or a shared device listing them    |
| `listOnSharedDevices` | account  | oneself with `account` and no restrictions; otherwise `admin`, on a kid          |
| `resetUnlockCode`     | account  | `admin`, on anyone in the household                                              |
| `manageDevices`       | server   | `admin`                                                                          |

### Edge cases settled in the build

- A device code from a device that became shared registers nothing: `enroll` fails `conflict`,
  and the app opens tiles from the picker instead.
- An approval made before its approver signed out everywhere no longer opens anything.
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
