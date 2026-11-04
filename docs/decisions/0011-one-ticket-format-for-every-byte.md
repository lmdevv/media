# 0011. Use one signed ticket format for every route that serves bytes

- Status: Accepted, 2026-11-03
- Decisions: D26

## Context

Both products sign media URLs in Convex and verify them on the media service, in different
formats.

- Movies' playback tokens are `v1.<payload>.<signature>`, an HMAC-SHA256 over a JSON payload that
  names the audience, user, profile, file, playback session, purpose, and expiry. They last six
  hours. The media service refuses a token whose playback session has ended, even before it
  expires, by watching the session in Convex (`docs/decisions.md`, "Playback tokens").
- Music signs a stream or an artwork hash with an expiry, using HMAC-SHA256
  (`packages/commands/src/signed-url.ts`). Artwork URLs name no user, so images cache.

Media elements such as `<video>`, `<audio>`, and HLS segment fetches cannot set headers, so the
signature has to travel in the URL.

## Decision

- Every byte-serving route takes one ticket format. A ticket is an HMAC over its audience,
  principal, resource, purpose, and expiry, with a key id for rotation. It travels as a query
  parameter.
- **Personal tickets** name the user and the session. They last up to 6 hours. The server watches
  the session's status and refuses a ticket as soon as its session is revoked.
- **Shareable tickets** name no one. Their expiry rounds to fixed buckets, so the same image gets
  the same URL for a while and caches.
- **HLS segments** inherit the playlist's ticket.

## Consequences

- Streams, downloads, artwork, subtitles, and trickplay images share one verifier on the server
  and one signer in Convex.
- Signing out ends playback within the server's watch on the session, not at ticket expiry.
- Keys rotate by key id, without a change to the format.
- Playback that outlives a personal ticket needs a new one. Movies' web player renews its token
  today. The register does not say how a Cast receiver, which keeps the URL it was given, gets a
  new ticket. The tickets PR in phase 3 settles it (`docs/architecture.md`, "Open").
- The purpose is signed, so each route can refuse a ticket made for another purpose, as movies'
  routes do today.

## Alternatives rejected

- Keeping two formats, one per product. One format serves every route.
- Headers for authentication on media routes. Media elements cannot set them.

## Edge cases settled

- An HLS segment request carries the playlist's ticket and needs no ticket of its own.
- A personal ticket never outlives 6 hours, even while its session stays live.
- A shareable ticket names no principal, so it carries no user id into a cached URL.
