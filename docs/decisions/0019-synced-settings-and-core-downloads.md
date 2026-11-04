# 0019. Mark which settings sync per user and run downloads as a core service

- Status: Accepted, 2026-11-03
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
