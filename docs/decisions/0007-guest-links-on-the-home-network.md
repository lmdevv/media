# 0007. Build guests into identity and keep v1 on the home network or Tailscale

- Status: Accepted, 2026-11-03
- Decisions: D20, D21

## Context

Music has jam guests, which are guest accounts made from a jam link. Movies has watch rooms for
its own users. Both products serve a household on a LAN or a tailnet, and movies' ports must not
face the internet today (`docs/operations.md`). Sharing a title or a playlist with someone outside the
household needs a guest model and an address that person can reach.

## Decision

- **Guests are part of identity and permissions.** A guest is a principal with the `guest` role
  (ADR 0005), not a feature of one domain.
- **Share links** point at a title, an episode, an album, a playlist, a track, or a group session.
- **Who may share.** An admin-wide switch allows guest links. Then each user needs the "can share
  with guests" permission.
- **What a guest gets.**
  - A link expires after 7 days by default and can be revoked.
  - A guest gives a display name.
  - A guest uses the web only, cannot download, and cannot browse or search.
- **Load.** Guests count against the server-wide transcode limit at the lowest priority (ADR 0014).
  Admins can see each link's activity.
- **Network.** v1 runs on the home network or Tailscale.
  - Tailscale Funnel is a valid way to open guest links to the internet.
  - Links use a configurable guest address.
  - Sign-in and link endpoints are always rate limited.
- **A public relay** is in the backlog. Cloudflare Tunnel decrypts traffic, so a relay that never
  sees content needs TLS passthrough.

## Consequences

- One guest model covers movies and music, and later products reuse it.
- A guest link works only where its guest address is reachable. Without Funnel or a relay, that is
  the home network or the tailnet.
- A guest's stream yields to household streams when the transcode limit is reached.
- Rate limits apply even on a home network.

## Alternatives rejected

- Guests owned by one domain, such as music's jam guests. Guests live in the core.
- Cloudflare Tunnel as the relay. It decrypts traffic. A future relay passes TLS through instead.
- Guest downloads, browsing, and search. A guest reaches only what the link names.

## Edge cases settled

- With the admin switch off, no user can create a guest link, whatever their own permission says.
- A revoked link stops working before its expiry.
- A guest in a group session can control playback only if the host allows it (ADR 0018).
- Links carry the configured guest address, which can differ from the address the household uses.
