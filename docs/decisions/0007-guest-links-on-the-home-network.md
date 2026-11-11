# 0007. Build guests into identity and keep v1 on the home network or Tailscale

- Status: Accepted, 2026-11-03. Amended 2026-11-07 with the phase 3 review fixes, and 2026-11-11
  with the sign-in boundary.
- Decisions: D20, D21, D45

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
  guest makes one. Both are rules of `can`'s `offer` and `make` share actions, so
  `core.guests.status` answers `mayShare: false` to an API key from the same decision.
- Only the host shares a group session. Someone still waiting to be let in is told so, as anyone
  else in the session is.

### Guests

- A guest is a `users` row of kind `person` and role `guest` that names its link. Each open lets
  a new guest in. `username` holds the name they typed: 1 to 32 characters after NFKC
  normalization, not unique. A name refuses control, private-use, and unassigned characters, line
  and paragraph separators, and the bidirectional controls that reorder what others see. It keeps
  zero-width joiners, which emoji sequences and several scripts need, and needs at least one
  visible character, so a name of zero-width spaces or fillers alone cannot show blank. `usernameKey` is `~<linkId>.<n>`, outside the username grammar, so
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
- Blocking a guest removes that guest and takes no place on the session's list of people turned
  away. The link can let its holder in again as a new guest, so a host who wants them out for good
  revokes the link or locks the session.
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
- Every sign-in passes the server's sign-in boundary, which applies the `signIn` budget per
  client address ("The sign-in boundary" below). The core refuses a sign-in that skipped it.

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

- Phase 4: the server reads `sessionStatus.guest` for transcode priority. The sign-in boundary
  below applies `@media/contracts/rate-limit`.
- Phase 7: the guest page in the account web client and a guest sign-in in the SDK.
- A purge of old links and their guests. The caps bound the rows until then.
- Connect: `deviceFor` names a guest's session membership once a device report names the session
  it plays (phase 6).

## The sign-in boundary (amended 2026-11-11)

Rate limits on sign-in always apply (D21), and the core never sees a client address. Every Convex
Auth sign-in used to travel straight to `auth:signIn`, over the Convex WebSocket or the HTTP API,
where no per-address limit could count it. `p4-signin-boundary` puts a boundary in front of every
sign-in that knows the address, and makes the core refuse any sign-in that skipped it.

### The route

- The media service answers `POST /api/auth/sign-in` (`SIGN_IN_PATH` in
  `@media/contracts/sign-in`, `apps/media/src/http/sign-in-boundary.ts`) with a body of
  `{ provider, params }`, as `auth:signIn` takes them, for every provider the core has:
  `password`, `apiKey`, `deviceCode`, `setup`, `invite`, `reset`, `tile`, `guest`, and `grant`. The
  route reads at most 16 KiB and refuses any other provider with `invalid_args`.
- It resolves the client's address as the other unauthenticated limits do (ADR 0027): the last
  `X-Forwarded-For` entry from a loopback peer, which Caddy sets to the client it resolved through
  `MEDIA_TRUSTED_PROXIES`, and the peer itself otherwise. Every client behind an untrusted proxy is
  that proxy, and a client that sends its own `X-Forwarded-For` through Caddy is still itself.
  Unlike the health route, a loopback peer without the header has no exemption here: the server's
  own sign-in never comes through the route.
- Every address becomes one written form before it keys a bucket or a pass's digest
  (`canonicalAddress` in `@media/contracts/rate-limit`): an IPv4-mapped IPv6 address becomes its
  IPv4 address, IPv6 is lowercased and compressed (RFC 5952), and brackets and zone ids are
  dropped. `203.0.113.9` and `::ffff:203.0.113.9` are one client with one budget, as Caddy keeps
  whichever form the socket gave it.
- It takes a try from the address's `signIn` bucket (10 at once, then one every 5 seconds) before
  it reads the body, so a malformed or refused sign-in costs a try too. Past the budget it answers
  `429` with `{ code: "rate_limited" }` and `Retry-After`, and the core never sees the call.
- Otherwise it relays the sign-in to the core's `auth:signIn` over the internal API URL
  (`CONVEX_URL`), with a pass for it among the params, and answers what the core answered: `200`
  with `{ tokens }`, or the core's `{ code, message }` with a status for its code (`pending` and
  `denied` included, which a device code's poll reads). A core that failed answers `500`, and an
  unreachable one `502`.
- The body holds a password, a key, or a link code, so nothing logs it. The route logs one INFO
  line per relayed sign-in with its provider and outcome, never the address or params; refusals
  past the budget log at DEBUG, as the access log does (`access-log.ts`), so a flood cannot rotate
  the retained log.
- A device code polls every 5 seconds, which the `signIn` door refills at, so a waiting device
  stays inside its budget.

### How the core refuses a sign-in that skipped the boundary

Every provider of the core is built with `behindBoundary` (`convex/core/auth/passes.ts`). Before
the provider sees its params, it takes the `boundaryPass` param out and checks it; with no good
pass it refuses with `forbidden`, one message for every reason. A refresh never reaches a provider,
so `auth:store` and the refresh path are unchanged.

- **A pass is an HMAC the server signs for one sign-in.** It is
  `p1.<kid>.<issuedAt>.<nonce>.<address>.<mac>`: the ring key's id, the time in milliseconds, 16
  random bytes, the first 16 bytes of the SHA-256 of the resolved address's canonical form, and an HMAC-SHA256 over those
  and the SHA-256 of the provider and its params in canonical JSON (`canonicalJson`, keys sorted at
  every level). The digest has one size for any address, so no forwarded value can make a pass
  too long, and no address is in the pass.
- **The keys derive from `MEDIA_TICKET_KEYS`.** Each ring key gives a pass key, the HMAC of the
  label `media sign-in pass v1` under it (`loadDerivedKeyRing` in `ticket.ts`). In the core,
  `core/tickets.ts` derives them, so it stays the only module that reads the ring. The server and the
  core already hold the ring, so no new setting exists, and passes rotate with tickets. A pass key
  never signs a ticket and a ticket key never signs a pass.
- **Not forgeable.** Only the server and the core hold the ring. A pass signed with any other key,
  or altered at all, fails its HMAC.
- **Not replayable.** The core takes a pass for 60 seconds after it was signed, 5 seconds of clock
  skew allowed, and only once. The provider checks the pass's HMAC in its action, where the key
  is, then hands the pass to the first mutation that writes for the sign-in (`password:attempt`,
  `apiKeys:redeem`, `deviceCodes:redeem`, `deviceGrants:redeem`, `users:setUp`,
  `invites:accept`, `resetLinks:redeem`, `links:open`; for a tile, `tiles:passwordAttempt` or
  `unlockCodes:attempt` when a proof is tried, and `tiles:open` otherwise). That mutation calls
  `spendPass` before any other write, and `spendPass` decides everything that needs no key, in the
  same transaction as the nonce and the writes it guards: the pass was signed for this provider,
  it has not expired by the mutation's own clock, and its nonce is not in `signInPasses`. Then it
  records the nonce with the provider and the address digest. The action's own expiry check only
  spares a call; a call that verified in time and reached its mutation after expiry is refused
  there.
- **A spent nonce outlives its pass.** The sweep, every 10 minutes, forgets a nonce only once its
  pass expired more than a minute ago (`SPENT_PASS_KEPT_MS`). By then every spender refuses the
  pass by its expiry alone, so forgetting the nonce never lets it in again. An earlier version
  forgot nonces at expiry and checked expiry only in the action, so two calls that verified before
  expiry could both spend one pass, the second after the sweep.
- **A refused sign-in.** The spend commits with the sign-in's first write, so no second sign-in,
  try, or session comes from one pass. A sign-in refused before any write (a malformed key, a
  refused lookup, or a mutation that throws and rolls back) leaves its nonce unspent, and the same
  request sent again within the 60 seconds is decided again, with the same params, as a new
  attempt; it changes nothing the first one did not.
- **Not usable for another sign-in or from another address.** The HMAC covers the provider, the
  params, and the address's digest, so a pass works only for the exact sign-in the boundary admitted for
  that address. The pass never leaves the server: the route signs it, sends it to the core on the
  install's loopback, and answers the client only what the core answered. A client never holds a
  pass to take elsewhere.
- **No secret in a mutation argument or a log.** The pass travels as an action param, as the
  password beside it does. The core checks it in the action and hands the mutation only the nonce
  and expiry, neither of them secret. The route logs neither.
- **The server's own sign-in.** `CoreSession` signs in with the server's service key straight to
  `auth:signIn`, with a pass it signs itself for the address `server`
  (`SignInPasses.ownSignIn`). The server is the boundary, and it never comes through the route, so
  a restart signs it in without spending a client's budget.

### Measured

A password sign-in, from the call to holding tokens, over 100 sign-ins a side in blocks of 10
interleaved, trunk straight to its core and the head through the boundary, each on a fresh core
on the same host: head minus trunk p50 was +1.0, +8.8, +3.4, +1.6, and +4.7 ms over five runs
(trunk p50 158.8 to 191.1 ms; Scrypt dominates). The boundary's own hop measured within noise:
189.6 ms straight to the core with a pass against 187.6 ms through the boundary. A first version
spent the nonce in a mutation of its own, one more commit per sign-in, about 12 ms on this host.

### Clients

- The platform SDK signs in through the boundary (`SignInRoute.Boundary` in `@media/sdk/effect`;
  `signInUrl` in `createPlatform` and `PlatformProvider`). Refreshes and sign-outs still go to the
  core directly. `signInUrlFor(server)` names the route of a server, and `signInUrlBeside(core)` the
  route beside a core at `<server>/convex`, as an install serves them.
- The web clients sign in at their own origin's `/api/auth/sign-in`; `VITE_SIGN_IN_URL` overrides
  it in development. The CLI signs in beside its core URL, or at `MEDIA_CORE_SIGN_IN_URL`, which
  the image's CLI wrapper points at its own Caddy.
- The development stack (`scripts/dev-stack.sh`) runs the boundary alone in a container on
  base + 7, built from the checkout (`apps/media/src/sign-in-boundary-main.ts`), and waits for it
  with a CORS preflight, which spends no try, so every stack
  suite and the web clients' development servers sign in through it with the refusal on. A suite
  that signs many people in from one host names each one as a client of its own with
  `X-Forwarded-For` from loopback, as Caddy would (`@media/sdk/testing/own-client`), so each gets
  a person's budget.

### Rejected

- **A sign-in admission from the server's service session.** The server would call a
  server-facing mutation for a one-time token before each sign-in. It costs a second round trip
  per sign-in, fails every sign-in while the server is signed out, and cannot admit the server's
  own sign-in.
- **A fixed shared secret in the params.** It is replayable by anyone who sees it once and binds
  no sign-in or address.
- **A new `MEDIA_SIGN_IN_KEY` setting.** It would hold the same trust as the ticket ring, held by
  the same two parties, and need a place in the image, Compose, the NixOS module, and both READMEs.
- **Exempting service keys from the pass.** The server can sign its own pass, so no provider needs
  an exemption that an attacker could aim at.
- **A public Convex HTTP action for sign-in.** It would need a site path on the public address
  (ADR 0025), and a Convex HTTP action still cannot see the client's address behind Caddy any
  better than the server can.
- **A switch that turns the refusal off for tests.** The development stack runs the boundary, so
  no suite needs one.
