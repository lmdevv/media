# 0006. Register every device and lock adult tiles on shared devices

- Status: Accepted, 2026-11-03
- Decisions: D18, D19

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
- After 5 wrong tries, the unlock code locks. The register does not say how it unlocks again.
  Movies locks a profile for five minutes after five wrong PINs today. The devices PR in phase 3
  settles it (`docs/architecture.md`, "Open").
- A kid cannot leave their own tile alone. An adult approves.
- A personal device never lists a user who is not signed in on it.
