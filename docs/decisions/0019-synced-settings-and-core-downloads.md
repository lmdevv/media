# 0019. Mark which settings sync per user and run downloads as a core service

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the settings table as built, and again
  with downloads as built. Amended 2026-11-07 with the `see` rule.
- Decisions: D36, D37

## Context

Users move between a phone, a laptop, an iPad, and a TV, and expect their preferences to follow
them. Some settings only make sense on one device, such as stream quality on a weak connection or
the volume. Movies has downloads for offline playback with expiry and storage rules
(`docs/decisions.md`, "Downloads"). Music clients also keep files offline. Each product decides
today, in its own code, what follows the user and what stays on the device.

## Decision

- **Synced per user:**
  - subtitle and audio language,
  - subtitle style,
  - autoplay,
  - explicit filter,
  - crossfade and gapless,
  - progress, history, likes, lists, and playlists.
- **Per device:**
  - stream quality,
  - download quality,
  - volume,
  - downloaded items.
- **One table in the core** marks each setting as synced or per device.
- **Downloads are a core service.** It decides:
  - who may download,
  - the item list per device,
  - storage caps,
  - re-sync,
  - expiry when access is revoked.
- Each domain packages its own files for download.

## Consequences

- A new setting gets one row in the core table, and every client reads its scope from there.
- Per-device settings and downloads key on the device registry (ADR 0006).
- Revoking a user's access to a library expires that user's downloads from it.
- Movies and music share one download policy and keep their own file formats.

## Alternatives rejected

- Each client deciding on its own which settings sync. One table marks each setting.
- Downloads built separately in each domain. The policy is core, and only the packaging is per
  domain.

## Edge cases settled

- Changing the subtitle language on a phone changes it on the TV too.
- Changing the volume on a phone leaves the TV alone.
- Guests cannot download (ADR 0007).
- A device's downloads expire when the access behind them is revoked.

## Settings as built (amended 2026-11-04)

The settings table is `settings` in `packages/commands/src/settings.ts`. The generator copies it to
`packages/platform/commands/settings.ts`, and the commands are in
`packages/platform/convex/core/settings.ts`.

### The table

One row per setting. A row names who holds the value, the domains whose players read it, the
value's validator, its default, and any check beyond the validator.

| Setting            | Held by | Read by       | Value                                                                            | Default               |
| ------------------ | ------- | ------------- | -------------------------------------------------------------------------------- | --------------------- |
| `subtitleLanguage` | user    | movies        | ISO 639-1 code, or null for subtitles off                                        | null                  |
| `audioLanguage`    | user    | movies        | ISO 639-1 code, or null for the file's default track                             | null                  |
| `subtitleStyle`    | user    | movies        | `size` small, medium, large; `color` white, yellow; `backdrop` none, shadow, box | medium, white, shadow |
| `autoplay`         | user    | movies, music | boolean: the next episode, or more music when the queue ends                     | true                  |
| `explicitFilter`   | user    | music         | boolean: hide explicit tracks                                                    | false                 |
| `crossfade`        | user    | music         | whole seconds, 0 to 12; 0 is off                                                 | 0                     |
| `gapless`          | user    | music         | boolean                                                                          | true                  |
| `streamQuality`    | device  | movies, music | auto, original, high, standard, low                                              | auto                  |
| `downloadQuality`  | device  | movies, music | standard, high                                                                   | standard              |
| `volume`           | device  | movies, music | 0 to 1                                                                           | 1                     |

- The table lists settings only. Progress, history, likes, lists, and playlists are domain data in
  each domain's tables. Downloaded items belong to the downloads service. A kid's restrictions are
  an admin's limits (ADR 0005), and `explicitFilter` never weakens `hideExplicitMusic`.
- Stream quality is one tier for both domains, since each app is its own device (ADR 0006). Movies
  plays `high`, `standard`, and `low` at 1080p, 720p, and 480p. `original` never transcodes.
- A new setting is one row in the table. The commands, their CLI flags, the stored fields, and the
  routing follow from it after `pnpm --filter @media/commands generate`.

### Who holds a value

- A `user` setting is one value per person, in `userSettings`.
- A `device` setting is one value per person per device, in `deviceSettings`, keyed by the device
  and the person. On a shared TV each person keeps their own volume and quality, so a kid who turns
  the volume up changes only the kid's volume.
- The device is the one the caller's session is on (`Caller.deviceId`). An API key, or a session
  whose app never registered, is on no device. `core.settings.get` shows `device: null` for it, and
  changing a device setting from it fails `conflict`.
- A missing row or field is the setting's default. A row exists once someone changes a setting.

### Commands

- `core.settings.get` takes no arguments and shows `{ user, device }`, every setting resolved to a
  value. It reads five documents a call. On an idle dev stack it answered in 4.9 to 5.7 ms at the
  median over 200 uncached calls, in four runs.
- `core.settings.set` takes any settings as optional arguments, such as
  `media auth settings set --subtitle-language fr --volume 0.4`, and shows the result as `get`
  does. It decides the caller's right to change each setting, then whether the session is on a
  device, then each value, before it writes anything. So a refused call changes nothing, and a
  session that may change nothing gets `forbidden` whatever values it sent.
- A CLI flag cannot carry null. To turn subtitles off from the CLI, pass
  `--json '{"subtitleLanguage":null}'`.
- Neither command takes a user, so no call names someone else's settings. An unknown setting is an
  unknown argument, which Convex refuses before the handler runs.
- Removing a device (`core.devices.registry.remove`) deletes every person's settings on it in
  scheduled pages. Its sessions end in the same transaction, so nobody reads them meanwhile.
  Changing a device's mode keeps them, and so does a person leaving a device: their settings come
  back when they sign in there again.

### The rule in `can`

| Action   | On      | Needs                                                                                                      |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `see`    | setting | the setting's own person, who is not a guest                                                               |
| `change` | setting | the setting's own person, who is not a guest, with `account` or the `play` scope of a domain that reads it |

- `get` decides `see` on the caller's own settings, so any live household session reads them and
  a guest from a share link reads none (ADR 0007). It needs no scope.
- Both commands are `signed-in`, because a tile on a shared device holds only domain scopes and
  must still read the subtitle language and change its volume.
- So a `movies:read` API key reads settings and changes none, and a `music:play` key changes
  `crossfade` but not `subtitleStyle`. Admins change no one else's settings.

Rejected in this build:

- Per-device settings keyed by the device alone. Everyone on a shared TV or a family iPad would
  share one volume and quality, and a kid's change would reach the adults.
- One row per setting value. Each row would hold a union of every setting's type, so a volume of
  `"fr"` would pass the schema, and `get` would read up to ten rows.
- `set({ name, value })`. A wrong value type would compile, and the CLI would take every value as
  JSON.
- One name per domain, such as `movies.volume` and `music.volume`. The table would no longer hold
  one row per setting in this ADR, and each app is already its own device.
- The `account` scope on the commands. It locks every tile session out of its own settings.

## Downloads as built (amended 2026-11-04)

The core keeps the list of what each person keeps on each device, decides on every read whether
each item may still play there, and holds each device to a storage limit. Packaging and serving
the bytes stay with each domain's server code in phase 4 (D50). The commands are in
`packages/platform/convex/core/downloads.ts`, and the domain interface is in
`convex/core/downloadSources.ts`.

### One row per wanted item

A row in `downloads` is one item one person keeps on one device: the device, the person, the item,
the quality it was added at, and the bytes it holds against the device's limit with the revision
those bytes were estimated for. The row stores no access state. The device's own disk is the only
record of which bytes it holds, so the core asks the device for no acknowledgement.

- An item is a typed reference `{ kind, id }`. `downloadKinds` in
  `packages/commands/src/access.ts` lists each kind once, with its table and the ticket resource
  its download serves (`file` or `track`). The validators derive from that list.
- `probe` is the only kind until the movies port. It names a `probeItems` row, the core's stand-in
  for a movie file or a track, and the port replaces it with movies' own kinds.
- Each kind has one loader in `downloadSources.ts`. A kind without one fails to compile. A loader
  reads the item live, and its library through a reader that reads each library once per call, and
  gives the library, the facts restrictions read, the ticket resource, an
  opaque revision, the bytes it packages at each quality, and a label. The probe's revision is its
  size and change time. A domain whose item can point at another file puts the file id in it.
- A container, such as an album, a playlist, or a season, is a domain command that adds its
  items one by one. The core has no container rows.

### The rule in `can`

| Action | On       | Needs                                                                                       |
| ------ | -------- | ------------------------------------------------------------------------------------------- |
| `keep` | download | not a guest; a personal device the session is on; and on the item exactly what `play` needs |

`can` decides in this order. A service is `hidden`. A guest is `forbidden` for every item and
device alike, so the refusal names no item (ADR 0007). A session on no device and a shared device
are `forbidden` (`no-device`, `shared-device`). Then the item is decided as `play` decides it: no
grant or a restriction is `hidden`, a missing `<domain>:play` scope is `forbidden`. The rule table
holds `shared: keeps-nothing`, so letting tiles download later is one edit there.

The item comes last, and `can` also decides an item that does not exist. The caller passes `item:
null`, and once the caller and the device pass, the answer is `hidden` (`missing`). So a missing
item and one the caller cannot see get the same answer from every command, for every caller. A
guest, a tile on a shared device, and a session on no device are refused for both alike. Anyone else
gets `not_found` "No such item" for both. Ordering the checks inside `can` was not enough. `add`
used to answer `not_found` for a missing item before it asked `can`, so a guest, a tile, or an API
key could tell from the refusal whether an item they cannot see exists.

`add`, `list`, and `fetch` all ask `keep`, with the caller's session as the principal. So a kept
item can never reach more than playing it would.

### Expiry is decided on every read

Nothing is written when access changes. `list` and `fetch` read each item, its library, the
person's grants and groups, and their restrictions in the call, and decide `keep` again. Convex
reruns a device's `list` subscription when any of those documents change, so a revoked grant
reaches an open app at once, and a device that was offline learns of it on its next list. No
access writer calls into downloads, and a revocation path added later reaches downloads as long
as it changes what `can` reads.

Each entry in `list` tells the device what to do with its copy:

| State       | Why                                                                               | The device                                                                   |
| ----------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `available` | `keep` allows it                                                                  | holds `revision`; fetches when its copy has another revision or none         |
| `expired`   | `access` (no grant or no scope), `restricted` (a kid's limits), `device` (shared) | deletes its copy and may keep the row; the item comes back if access returns |
| `gone`      | the item or its library no longer exists                                          | deletes its copy and calls `remove`                                          |

A device deletes a local copy that no entry lists only after it has read every page of the list.

### Commands

| Command                 | Kind     | Scope       | What it does                                                                                                  |
| ----------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `core.downloads.add`    | mutation | `signed-in` | keeps an item on the caller's device at the person's `downloadQuality` there; adding it again changes nothing |
| `core.downloads.list`   | query    | `signed-in` | the caller's items on the caller's device, newest first, 200 a page at most, each with its state              |
| `core.downloads.fetch`  | mutation | `signed-in` | decides `keep` again and issues a `download` ticket for the current revision, valid 15 minutes                |
| `core.downloads.remove` | mutation | `signed-in` | deletes the caller's row for an item and frees its bytes; removing it again changes nothing                   |
| `core.downloads.usage`  | query    | `signed-in` | the device's bytes and items for everyone on it, and its limits                                               |
| `core.downloads.setCap` | mutation | `admin`     | sets one device's byte limit, or null for the default                                                         |

- Every command but `setCap` takes an item, not a row id, and finds the row by the caller's device
  and person. No command names another person's row.
- `add` decides `keep` before it looks for the caller's row. Adding an item already kept changes
  nothing while `keep` allows it, and is refused like any other add once the item has expired.
- A session on no device, such as an API key, gets `conflict` ("register this app first") for any
  item, whether or not it exists.
- `list` and `fetch` read only the caller's own rows, and `remove` answers the same whether or not a
  row exists. They tell `gone` from `expired` only for an item the person added, which `add` let
  them see then. A person who lost access can learn that such an item was later deleted, and no
  more. The device needs the difference to know whether the item can come back.
- The commands are `signed-in`, like the settings commands, because the item's domain decides which
  `play` scope `keep` needs.
- A ticket lasts 15 minutes because a download is admitted on each request (ADR 0011). A transfer
  that resumes after a revocation needs `fetch`, which then answers `expired`.

### Storage limits

- The limit is per device and counts everyone on it, because people on one device share its disk.
  It is bytes as each domain estimated them at the row's quality, rounded up to whole bytes. The default is 64 GB, and an
  admin sets another with `setCap` under `manageDevices`, as the other device settings are. A
  limit of 0 refuses every download that takes any space.
- A device also keeps at most 500 items, which bounds its list and its purge.
- Two sharded counters per device hold the totals, `downloadBytes:<device>` and
  `downloadItems:<device>`. `add` reads every shard of both, so two adds at once on one device
  conflict, and Convex retries one against the new totals. A stack test runs four adds at once
  where two fit, and exactly two get in.
- Only `add` checks the limit. Fetching a newer revision estimates its bytes again and moves the
  total, and a file that grew is never refused, so a device can go over its limit. Its next `add`
  is refused until something is removed.
- An expired row keeps its bytes against the limit, so access coming back never trips it. To free
  that space, the person removes the row.

### Re-sync

When a scan sees a file change, it patches the item's size and change time, and the item's revision
changes. The device sees a new revision in `list`, calls `fetch`, downloads the file to a
temporary path, and replaces its copy. `fetch` estimates the bytes again for the new revision and
moves the device's total by the difference.

### Devices

- Removing a device deletes its downloads in pages from the registry's purge, then its two
  counters and its limit. Its sessions end in the same transaction, so nobody reads them meanwhile.
- Making a device shared writes nothing. A tile on it sees every item as `expired` with `device`,
  and `add` is `forbidden`. Making it personal again brings the items back for the person who
  signs in there again.
- Signing out keeps a person's rows, as it keeps their device settings. They show again when the
  person signs in on that device. Their bytes keep counting against the device's limit, because
  their copies stay on the device. An admin frees the space by raising the limit or removing the
  device.

### Phase 4

The server's download route admits a `download` ticket for the resource `fetch` returned and
packages the item at the row's quality. The device sends the quality, which is a preference, not a
security boundary, so the ticket does not carry it. Byte ranges must work so that a transfer can
resume with a new ticket.

### Edge cases settled

- Removing a group member, a household grant, or a user grant expires what only that grant
  allowed. Lowering a grant to `view` expires nothing, because playing needs only `view`.
- A kid restriction expires exactly the items it hides, with `restricted`, and lifting it brings
  them back.
- Removing a library makes its items `gone` before its items are purged.
- A guest is refused with "Guests cannot download" whatever the item and device.
- A session whose scopes lack a domain's `play` sees that domain's items as `expired` with
  `access`. Each app is its own device, so this happens only when an app signs in again with
  fewer scopes.
- Changing `downloadQuality` changes new downloads only. To change an item's quality, the device
  removes it and adds it again.

Rejected in this build:

- A stored lifecycle per row (`live` or `expired`) written by a recheck that each access writer
  calls, with a sweep for writers that forget. Seven modules would each have to remember downloads,
  a forgotten call would leave a copy playable until the sweep, and undoing a revocation would
  need the reverse fan-out. Its one gain, a list that reads only its own rows, is not worth that.
- A device acknowledging each revision it holds. The core and the device would each own a copy of
  that fact, and the copies drift whenever the app's data is wiped.
- A limit each person on the device sets. A kid could change it for everyone on a family iPad, and
  admins already manage devices.
- A limit per person on a device, as a device setting. Two people on one disk could together pass
  it, so "a device at its limit" would not hold.
- Downloads as playback sessions with per-device and per-account counts, as old movies had. ADR 0011
  removed ticket renewal, and evicting the quietest download surprises people.
- A download command per domain, such as `movies.downloads.add`. There would be two ways to keep
  an item, and the policy this ADR puts in the core would split. A domain gives one loader.
