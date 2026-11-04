# 0018. Put remote control and casting in the core and keep third-party support small

- Status: Accepted, 2026-11-03
- Decisions: D35, D44

## Context

Music has Connect-style remote state, so one user's devices can see and control each other's
playback. Movies casts to Chromecast with Google's Default Media Receiver, plays to AirPlay from Safari,
and has a Jellyfin and Plex importer (`docs/decisions.md`, "Casting and system controls" and
"Migration from Jellyfin and Plex").
Self-hosted media servers often add compatibility layers for other clients, such as the Subsonic
API for music or the Jellyfin API for video.

## Decision

- **Connect is core.** Remote control in the style of Spotify Connect, plus loose sync of about a
  quarter second, live in the core for both domains.
- **Casting.** Chromecast and AirPlay are Connect targets, driven from a phone or a browser.
  - Cast starts with Google's default receiver.
  - The server transcodes to formats Cast can play.
- **Tight same-room sync** is in the backlog.
- **Who may control a device.**
  - A user's own devices, always.
  - A shared device, by any household user that device lists.
  - Another person's personal device, never.
  - A guest, only inside their session and only if the host allows it.
- **Third-party support now** is Chromecast and AirPlay.
  - No Subsonic API and no Jellyfin API compatibility.
  - Movies' existing Jellyfin and Plex importer stays.
  - Everything else goes to the backlog.

## Consequences

- Connect state keys on the device registry (ADR 0006), so a phone can control a TV only when the
  TV is the same user's device or a shared device that lists the phone's user.
- A Cast session plays through the same tickets as any other stream (ADR 0011).
- Third-party music apps cannot connect through a Subsonic API. The products' own clients and the
  CLI are the way in.
- Loose sync keeps devices about a quarter second apart. Playing in step in one room waits for
  tight sync in the backlog.

## Alternatives rejected

- Subsonic and Jellyfin API compatibility. Neither is built. Other integrations wait in the
  backlog.
- A custom Cast receiver at the start. Cast starts with Google's default receiver.
- Tight same-room sync in v1. It is in the backlog.

## Edge cases settled

- A user can never control another person's personal device, even in the same household.
- A guest controls playback only inside their own session, and only when the host allows it.
- A shared device is controllable by every household user it lists.
- Music importers from Jellyfin, Plex, or Navidrome are not built now. They are backlog proposals
  (ADR 0022).
