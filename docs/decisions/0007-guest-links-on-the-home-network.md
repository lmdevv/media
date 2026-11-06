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

## Guest links as built (amended 2026-11-06)

The commands are in `packages/platform/convex/core/guests.ts` and `convex/core/guests/`, the
rules are in `convex/core/permissions/policy.ts`, and the `guest` sign-in provider is in
`convex/core/auth/flows.ts`. Phase 3 wires no client (D50). The account web client adopts guest
links in phase 7.

### Links

- `core.guests.links.create` makes a code `mg_<linkId>.<secret>` from 32 random bytes. The core
  stores its SHA-256, as it stores invite codes (ADR 0003), so the code is shown once.
- The link's address is `<guest address>/guest#<code>`. The code rides in the fragment, which
  browsers never send, so no request line, proxy, Funnel log, or server log holds it.
- A link names an item (`domainItem`, so titles, episodes, and tracks once the ports add their
  types) or the group session its maker hosts in a domain. The session is stored by id, so the
  link never follows its maker into another session. An album or a playlist adds one case to
  `covers` in `permissions/items.ts`.
- A link lasts 1 to 30 days, 7 by default. Its maker or any admin revokes it with
  `core.guests.links.revoke`. Revoking a session link also takes its guests out of the session.

### Who may make links

- `core.guests.configure` turns guest links on or off and sets the guest address, an http or https
  origin. Only an admin calls it, never with an API key, and turning links on needs an address.
- While guest links are off, no link can be made or opened, and every guest is signed out at once.
  Turning them off bumps an epoch that each link stamps, so turning them on again revives no link.
- Owners and admins may always make links. A member needs `core.guests.allow`. An admin could
  allow themselves, so a flag on admins would guard nothing.
- Stopping a member ends their sessions (ADR 0005). Each link stamps its maker's session
  generation, so their links stay dead even if an admin allows them again. Signing out everywhere,
  a password change, and a demotion end a maker's links the same way. A promotion clears the
  member's allowance.
- Making a link needs the `account` scope and refuses API keys, so no key, shared-device tile, or
  guest makes one.

### Guests

- A guest is a `users` row of kind `person` and role `guest` that names its link. Each open lets
  a new guest in. `username` holds the name they typed: 1 to 32 characters after NFKC
  normalization, not unique. A name refuses control, private-use, and unassigned characters, line
  and paragraph separators, and the bidirectional controls that reorder what others see. It keeps
  zero-width joiners, which emoji sequences and several scripts need. `usernameKey` is `~<linkId>.<n>`, outside the username grammar, so
  password sign-in never finds a guest and a display name cannot collide with a household
  username. `core.accounts.users.list` stops below `~`, so it lists no guest.
- A guest signs in with the `guest` provider and `{ code, name }`. One mutation finds the link,
  decides `open`, adds the guest, seats them for a session link, and opens a `guest` session that
  ends no later than the link. Every refusal of a code answers `expired` with one message. No
  query looks a link up before sign-in, because a query cannot take a rate-limit token.
- A guest's session holds `movies:play` and `music:play` only. Without `account`, `admin`, or a
  `read` scope, a guest cannot browse, search, make keys, or register or approve a device.
  Downloads refuse guests (ADR 0019). A guest holds no device, and only the web client has a
  guest flow, which is what web only means in the core.
- A guest keeps no settings. The settings rule in `can` refuses a guest `see` and `change`, so
  `core.settings.get` and `core.settings.set` answer `forbidden` and no settings row names a
  guest. This adds `see` to the setting actions of ADR 0019, where reading had no rule. A
  household session, an API key, and a tile still read their own settings with any scope.
- `core.guests.current` tells a guest's client what the link names, who shared it, and when it
  stops working.

### Live checks

- `liveSession` checks every guest session against its link with three point reads: the link,
  the switch, and the maker. A revoke, the switch, a stopped member, or a maker's new session
  generation ends the guest at once, in every command and in the server's ticket watch. The watch
  (`core/tickets:sessionStatus`) reruns because it read those rows. A guest session expires with
  its link, so the watch's `endsAt` is the link's expiry.
- `sessionStatus` answers `guest: true` for a guest's session. The phase 4 server uses it to put
  guest streams at the lowest transcode priority (ADR 0014).
- The maker's access to what the link names is decided when the link opens and at every play,
  not in the live check. A guest's running stream continues after the maker loses access, as a
  household person's does when they lose a grant (ADR 0011). Checking access in `liveSession`
  would read the maker's grants and groups on every guest call, rerun every guest's views on each
  move of a session's clock, and need the permissions modules split to avoid an import cycle.

### What a guest plays

- `playableBy` in `permissions/items.ts` decides a guest through their link. The link must cover
  the item: an item link covers that item, and a session link covers the session's item and its
  queue. Then `can` decides `play` with the maker as the principal, so the maker's grants and
  restrictions are the ceiling. A kid allowed to share cannot share what their restrictions hide.
- A guest holds no grant, so `requireContent`, `requireItems`, and `visiblePage` hide everything
  from them. A phase 4 play command decides one item with `requirePlayable`. `requireItems` gates
  browsing, which a guest never passes.

### Group sessions

- Opening a session link enters the guest through `enter` under the join setting: open joins,
  approval waits for the host, and locked refuses. The facts gain `invited`, which only opening
  the link sets, so a guest never enters through an `mt_` join link.
- A guest controls playback when the host allows it, and never adds or removes queue entries,
  since a guest cannot browse for anything to add. `core.together.get` marks a guest member
  `linkGuest`, so a typed name cannot pass for someone in the household.
- Blocking a guest removes that guest. The link can let its holder in again as a new guest, so a
  host who wants them out for good revokes the link or locks the session.
- A guest's seat lasts only while their link holds. The seat count reads each guest member's
  link, so a link that expires, a switch turned off, or a maker who lost the right to share frees
  the seat at once, even for a guest who went quiet before it died. The next person to enter the
  session deletes the dead rows, and the presence sweep drops a silent guest whose link stopped
  holding. `core.together.get` skips the same guests and reruns when a link, the switch, or a
  maker changes. Convex does not rerun a query as time passes, so a guest whose link only expired
  leaves an open view at the session's next change.

### Limits

- The core lets 30 guests in per link per hour, counting only guests who got in, and 50 per link
  in all. A link at its limit still answers a dead code like any other dead code. A person makes
  at most 30 links an hour.
- `@media/contracts/rate-limit` holds the per-address budgets for calls that need no session:
  `signIn` (10 at once, then one every 5 seconds) and `public` (60 at once, then 2 a second),
  and `admit`, a pure token bucket. The core never sees a client address, so the server applies
  them from phase 4.
- Until phase 4, nothing limits sign-ins per address. The `guest` provider, like every Convex
  Auth sign-in, travels over the Convex WebSocket or `auth:signIn`, which no per-path HTTP limit
  can count, and `@media/contracts/rate-limit` has no caller in production. Only the per-link and
  per-maker limits in the core apply. Phase 4 routes sign-ins through a boundary that knows the
  address and applies the `signIn` budget there.

### Rules in `can`

| Action            | On          | Needs                                                                                                             |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `configureGuests` | server      | `admin`                                                                                                           |
| `allowSharing`    | account     | `admin`; a member                                                                                                 |
| `offer`           | share       | guest links on; an owner, an admin, or an allowed member; `account`                                               |
| `make`            | share       | what `offer` needs, and the maker plays the item or hosts the live session                                        |
| `open`            | share       | the link's own guest; the link stands; its maker still plays the item or hosts the live session                   |
| `hold`            | share       | the link's own guest; the link stands                                                                             |
| `play`            | share       | what `hold` needs; the link covers the item; the guest's `<domain>:play`; seated in a session; the maker plays it |
| `audit`, `revoke` | shareRecord | one's own link with `account`, or anyone's with `admin`                                                           |
| `see`             | shareRecord | one's own link only, so an admin never sees what someone else shared                                              |

A link stands while guest links are on in the epoch it was made in, its maker may still make links
and holds the same session generation, and it is neither revoked nor expired. A refusal for a
share link reads the same to a guest whatever the reason.

### Activity

`core.guests.links.list` shows the caller's links, or every link to an admin, newest first. An
admin sees each link's maker, kind, domain, state, and expiry, never what it names.
`core.guests.links.activity` lists the guests a link let in, with the names they gave and when,
to its maker or an admin. The guest rows are the activity, so nothing keeps a second copy.

### Measured

`test/core/guests/perf.test.ts` opens guest links 100 times on the dev stack, spread over four
links to stay under each link's hourly limit, after one warm-up open. Each open is the
`auth:signIn` round trip over HTTP. Two runs measured p50 47.8 and 43.0 ms and p95 69.4 and
52.1 ms, against a budget of 150 ms at p50. A guest's `core.guests.current` read 10 documents,
three of them the live check on the link.

### Left for later

- Phase 4: the server applies `@media/contracts/rate-limit`, routes sign-ins where an address is
  known, and reads `sessionStatus.guest` for transcode priority.
- Phase 7: the guest page in the account web client and a guest sign-in in the SDK.
- A purge of old links and their guests. The caps bound the rows until then.
- Connect: `deviceFor` names a guest's session membership once a device report names the session
  it plays (phase 6).
