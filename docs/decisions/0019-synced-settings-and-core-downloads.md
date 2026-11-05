# 0019. Mark which settings sync per user and run downloads as a core service

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the settings table as built.
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

| Action   | On      | Needs                                                                                  |
| -------- | ------- | -------------------------------------------------------------------------------------- |
| `change` | setting | the setting's own person, with `account` or the `play` scope of a domain that reads it |

- Reading needs no rule of its own. `get` shows only the caller's settings, so any live session
  reads them.
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
