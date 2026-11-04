# 0011. Use one signed ticket format for every route that serves bytes

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the format as built and with how long
  playback and Cast keep their ticket.
- Decisions: D26, D46

## Context

Both products sign media URLs in Convex and verify them on the media service, in different
formats.

- Movies' playback tokens are `v1.<payload>.<signature>`, an HMAC-SHA256 over a JSON payload that
  names the audience, user, profile, file, playback session, purpose, and expiry. They last six
  hours. The media service refuses a token whose playback session has ended, even before it
  expires, by watching the session in Convex (`docs/decisions.md`, "Playback tokens").
- Music signs a stream or an artwork hash with an expiry, using HMAC-SHA256
  (`legacy/music/packages/commands/src/signed-url.ts`). Artwork URLs name no user, so images
  cache.

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
- A personal ticket's 6 hours limit when a stream may start. Once a stream starts, its later
  requests are authorized by the stream itself while its session stays live (D46).

## Consequences

- Streams, downloads, artwork, subtitles, and trickplay images share one verifier on the server
  and one signer in Convex.
- Signing out ends playback within the server's watch on the session, not at ticket expiry.
- Keys rotate by key id, without a change to the format.
- Playback that outlives a personal ticket needs no new ticket, and neither does a Cast receiver
  that keeps the URL it was given. Only a new start does. "Long playback and Cast" below has the
  details.
- The purpose is signed, so each route can refuse a ticket made for another purpose, as movies'
  routes do today.

## Alternatives rejected

- Keeping two formats, one per product. One format serves every route.
- Headers for authentication on media routes. Media elements cannot set them.

## Edge cases settled

- An HLS segment request carries the playlist's ticket and needs no ticket of its own.
- A personal ticket never starts anything more than 6 hours after it was issued, even while its
  session stays live. A stream it started keeps playing past that while the session is live.
- A shareable ticket names no principal, so it carries no user id into a cached URL.

## Tickets as built (amended 2026-11-04)

The tickets PR in phase 3 built the format, the issuing functions, and the session status, with no
server route using them yet (D50). The server's routes adopt them in phase 4.

- **One module.** `packages/contracts/src/ticket.ts` signs and verifies, and has no imports. The
  core's Convex functions, which run no Effect, and the server load the same file, so the two
  sides cannot drift. A test fails if the file gains an import. `ticket-vectors.ts` pins its bytes
  with MACs computed by Node's `createHmac`.
- **Format.** `t1.<kid>.<aud>.<iat>.<exp>.<purpose>.<kind>.<id>.<principal>.<mac>`, plain ASCII
  that needs no escaping in a URL. `iat` and `exp` are whole seconds. The principal is
  `s.<userId>.<sessionId>` for a personal ticket and `a` for a shareable one. The MAC is
  HMAC-SHA256 over the text before it, keyed with the raw key that `kid` names. One set of claims
  has one encoding, so every shareable ticket for one artwork in one bucket is the same string.
- **Purposes and resources.** The purposes are `play`, `download`, and `image`. A ticket names a
  `file`, a `track`, or an `artwork` by id. A shareable ticket is always `image` on `artwork`.
  Adding a kind means one line in `ticketResourceKinds`.
- **Keys.** `MEDIA_TICKET_KEYS` holds `<kid>:<key>` entries separated by commas, each key 32
  random bytes in unpadded base64url. The first entry signs, and every entry verifies. A key id is
  never reused for another key. To rotate, add the new key last wherever tickets are verified and
  on the core, then move it first on the core, then remove the old key once
  `TICKET_KEY_RETENTION_MS` (two artwork buckets plus a minute) has passed since it last signed.
  `scripts/dev-stack.sh up` sets a fresh key on the core when it has none.
- **Limits the verifier checks itself.** A personal ticket's `exp` is at most 6 hours after its
  `iat`. A shareable ticket's `iat` falls on a 7-day bucket and its `exp` two buckets later, so
  it admits for 7 to 14 days. These hold whenever a ticket is checked, not only when it is fresh.
- **Clock skew.** A ticket issued up to a minute ahead of the verifier's clock is accepted. Expiry
  gets no grace: a ticket is expired at its `exp`.
- **Checks in order.** Shape, key id, MAC (compared in constant time by WebCrypto's `verify`),
  audience, the limits above, purpose, resource, issue time, expiry, then the session for a
  personal ticket. A refusal names the first check that failed and never holds the ticket's text.
- **Live revocation.** Admitting a personal ticket asks the verifier's host whether its session
  is live. The core's `core/tickets:sessionStatus` answers for the server's watch. It reruns when
  the session or its user changes (sign-out, `endAll`, a key revoke) and gives the session's
  expiry, which the server enforces on its own clock because a subscription does not rerun as
  time passes. It is an internal function behind `core/lib/serverFacing.ts` until the server signs
  in with the `media-service` scope (ADR 0010).
- **Issuing.** Domain commands call `issuePersonalTicket` after their own access check. It caps
  the expiry at 6 hours and at the session's own expiry, and it takes a mutation context because
  a cached query result would hand out an old personal ticket. `issueShareableTicket` works in a
  query, since a cached result stays valid for at least one bucket.
  `core/ticketsProbe.ts` runs both for the stack tests until the first domain command issues
  tickets.

## Long playback and Cast (amended 2026-11-04)

The register left open how playback longer than a ticket, and a Cast receiver that keeps the URL
it was given, get a new ticket. D46 settles the principle, and this section settles how.

### Decision

- **A ticket admits a stream once.** The first request of a stream, such as an HLS playlist or
  the first byte range of direct play, is admitted with the ticket. The server keeps the
  admission with its stream.
- **The stream continues on its admission.** Every later request of that stream carries the same
  ticket, because the playlist copies its ticket onto each segment URL. The admission accepts it
  while the session is live, whatever the ticket's expiry. It compares the ticket with the one it
  admitted and reads neither the clock nor a key.
- **No renewal.** No command or route trades a ticket for a new one. A stream that keeps playing
  needs nothing, so a Cast receiver never needs a new URL mid-movie.
- **A new start needs a fresh ticket.** A client that must start again after its ticket expired
  calls the domain command that started playback again. A Cast sender does this for its receiver
  and reloads it at the last position the receiver reported. The receiver holds no credential.
- **Only streams continue.** Downloads and artwork are admitted on each request, so an expired
  download ticket gets a new one from the download command.

### Consequences

- Playback of any length needs one ticket per start. A leaked URL can start nothing 6 hours after
  it was issued, and nothing at all once its session ends.
- Removing a key refuses new starts with its tickets but leaves running streams alone, because an
  admission does not use the key again. Ending the session is what stops a running stream.
- A server restart drops every admission. Players start again through the domain command. A Cast
  receiver shows a short reload.
- Movies' `playback.renewToken` has no successor in the core. The movies port's player stops
  renewing.
- A presentation query returns artwork URLs, and Convex does not rerun a query as time passes.
  A client that keeps a subscription open for more than a week can hold expired artwork URLs, so
  it runs the query again when an image is refused.

### Alternatives rejected

- Renewing mid-stream. Google's default receiver keeps its URL and cannot take a new ticket, and a
  custom receiver is out of scope (ADR 0018).
- Longer tickets for Cast. A leaked URL could start new streams for that long.
- Accepting any expired but authentic ticket on stream routes. A route could not tell a running
  stream from a new one, so an expired ticket would start streams forever.
- A route that refreshes tickets. The server would issue tickets with its own policy, and the
  core issues every ticket.

### Edge cases settled

- A seek inside a running HLS stream is a later request of that stream, even when the server
  restarts its encoder.
- A download resumed after its ticket expired needs a new ticket from the download command.
- A Cast session paused until the server drops its stream resumes through the sender's reload.
