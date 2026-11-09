# 0004. Use Convex Auth v1 behind a thin interface and check every session live

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with how sign-in was built, again on
  2026-11-04 to give each API key sign-in its own session, again on 2026-11-04 with the
  account sign-ins, and on 2026-11-09 with the core's store in front of Convex Auth's.
- Decisions: D14

## Context

Both repos use Convex Auth v1 (`@convex-dev/auth` 0.0.96, stable). Movies adds API keys and device
code sign-in on top of it. Music adds a cutoff model that ends sessions and keys early.

Convex Auth v1 has no passkeys, two-factor, or generic OIDC. Convex Auth v2 is in beta and has no
migration path from v1. Better Auth's Convex adapter is pinned to Better Auth 1.6 and cannot run on
Better Auth 1.7. Better Auth 1.6 has open vulnerabilities.

Convex Auth v1 keeps a deleted session valid until its JWT expires. Deleting a session row alone
does not sign anyone out.

## Decision

- Use Convex Auth v1 (0.0.96) with three credential providers of our own:
  - username and password,
  - API key,
  - device code.
- Put Convex Auth behind a thin internal interface, so Convex Auth v2 can replace it once v2 is
  stable.
- Every access check also confirms that the session is live. It uses music's cutoff model:
  `sessionsValidAfter`, `keysValidAfter`, and a `generation` counter.
- Keep JWT lifetimes short.

## Consequences

- Signing a user out, revoking a key, or changing a password takes effect on the next call, not
  when the JWT expires.
- Every Convex function that reads `ctx.auth` goes through the internal interface. No function
  calls Convex Auth directly.
- A move to Convex Auth v2 changes the interface's implementation and leaves callers alone.
- Short JWTs mean clients refresh more often.

## Alternatives rejected

- Better Auth. Its Convex adapter is pinned to Better Auth 1.6, which has open vulnerabilities.
- Convex Auth v2 now. It is in beta with no migration path from v1.
- Trusting the JWT alone. A deleted session would stay valid until its JWT expires.

## Edge cases settled

- A deleted session with an unexpired JWT is refused, because the live check finds it gone.
- Ending all of a user's sessions moves `sessionsValidAfter` to now and bumps the user's session
  generation. A session opened in an earlier generation no longer counts, even if it raced the
  change. In music today this lives in `packages/backend/convex/lib/sessions.ts`.
- Moving `keysValidAfter` to now stops every API key the user made before that moment.
- Passkeys, two-factor, and OIDC stay out of scope while v1 lacks them (ADR 0003).

## Sign-in as built (amended 2026-11-04)

The first sign-in in the core settled the interface, the session record, and the cutoff fields.

- **The interface.** `convex/core/auth/caller.ts` is the only code that reads who is calling.
  `requireCaller` serves queries and mutations, and `requireActionCaller` serves actions through
  an internal query. Generated command handlers get a `ctx` without `auth`. Lint bans
  `@convex-dev/auth` outside `convex/auth.ts` and `convex/core/auth/`, and a test fails on any
  other code that reads the caller. A move to Convex Auth v2 rewrites that folder and
  `convex/auth.ts`.
- **One session record.** Convex Auth's `authSessions` row holds how the session signed in
  (`password`, `apiKey`, or `deviceCode`), its scopes, and its generation. Every provider opens its
  session through `openSession` in `convex/core/sessions.ts`, so Convex Auth only mints tokens.
  The generation is required, so Convex Auth cannot open a session by itself. The live check
  reads the session and the user, two point reads, for every kind.
- **Generations replace both time cutoffs.** The user row carries `sessionGeneration` and
  `keyGeneration`. A password or device session is live while its generation equals the user's
  `sessionGeneration`. An API key, and the session it opened, works while its generation equals
  the user's `keyGeneration`. Ending every session or every key bumps one counter on the user row
  and reads nothing else.
  - `sessionsValidAfter` is dropped. Music needed it for sessions Convex Auth opened by itself,
    which had no generation. The core has none.
  - `keysValidAfter` becomes `keyGeneration`. A time cutoff compares a millisecond clock with
    creation times across concurrent transactions, so a key made in the same millisecond as the
    cut can land on either side. A counter is read and written inside the transaction, so it is
    exact.
  - A device approval records the approver's `sessionGeneration`. Ending every session before the
    device signs in voids the approval.
- **Lifetimes.** JWTs last 10 minutes. The live check refuses an ended session on its next call,
  so the JWT lifetime bounds how long a leaked token is an identity at all and what refreshing
  costs. Sessions last 30 days. An API key session lasts 30 days or until the key expires.
- **Credentials.**
  - Passwords are Scrypt hashes in a `passwords` table keyed by the user id. Sign-in takes a try
    from a per-username token bucket (10 an hour) before any hashing, unknown usernames included,
    and verifies an unknown username against a dummy hash, so its timing tells nothing. A
    successful sign-in gives its try back.
  - An API key is `mk_<keyId>.<secret>`, and a device code is `dc_<codeId>.<secret>`. Only the
    SHA-256 of the secret is stored, and it is compared in constant time after a lookup by id.
    Each sign-in with a key opens its own session, and a key keeps its newest 100 (see "One
    session per API key sign-in" below). A key cannot create a key or approve a device, even with
    the `account` scope, so a leaked key cannot mint a credential that outlives its own revocation.
    A key's name, and a device code's client name, follow the device-name rule (ADR 0006): a
    name that breaks it is refused with `invalid_args`.
  - A device code lasts 10 minutes, at most 50 wait at once, and the device polls `auth:signIn`,
    which answers `pending`, `denied`, or `expired` until approval. After approval the code signs
    the device into the same session until it expires, so a lost answer costs only a retry.
- **Cleanup.** Ending a session deletes it at once, then its refresh tokens 256 a call, scheduling
  the next call until none is left: a session gathers one per JWT, thousands over 30 days, more
  than one call may delete. `auth:signOut` and the refreshes below end sessions the same way.
  Revoking a key deletes its sessions at
  once and leaves their refresh tokens to the sweep. Ending every session or key deletes the ended
  rows in scheduled batches, and schedules each ended session's refresh tokens the same way. An hourly sweep deletes expired refresh tokens, old device codes, and
  idle rate-limit buckets.
- **Scopes.** `account` is the first credential scope (ADR 0005). It manages the caller's own
  credentials. A password session holds every scope its user may use. A key or device session
  holds the scopes it was granted, which must be a subset of the granting session's, cut down to
  what its user may use on every call.
- **Sign-in calls.** A client calls `auth:signIn` with a provider and its params:
  `password` with `{ username, password }`, `apiKey` with `{ key }`, or `deviceCode` with
  `{ deviceCode }`. It refreshes with `{ refreshToken }` and signs out with `auth:signOut`. The
  account sign-ins below add `setup`, `invite`, and `reset`.
- **Users.** There is no open sign-up. ADR 0003's "Accounts as built" lists every way a user is
  made.
- Convex Auth's tables for email, OAuth, and its own password provider are left out of the
  schema, because the core never reaches the code that uses them.

## One session per API key sign-in (amended 2026-11-04)

The first build shared one session among every sign-in with a key, and pruned the session's
refresh tokens to its newest 100. Convex Auth treats a session as one client's. When a client
refreshes with a refresh token that no longer exists, Convex Auth deletes the whole session and
all of its refresh tokens, and `auth:signOut` deletes the whole session too. So one old client of
a key, refreshing with a pruned token, signed out every other client of that key, and so did one
client signing out.

- **Decision.** Each sign-in with a key opens its own session, as a password sign-in does.
  Opening one ends the key's sessions beyond its newest 100, refresh tokens included, so a script
  that signs in on every run keeps at most 100 sessions and their tokens. A client whose session
  ended that way signs in with the key again.
- **Revocation still ends every client at once.** Revoking a key deletes all of its sessions in
  the same call. They are at most 100 rows, and their refresh tokens are left to expire and be
  swept, so revocation stays inside one call's write limit however much the sessions refreshed.
  Ending every key bumps `keyGeneration`, which every key session checks.
- **The criteria of the first build still hold.** The live check still reads the session and the
  user. A sign-in reads at most 101 sessions of its key, plus the refresh tokens of the one session
  it ends, where it used to read 120 refresh tokens. The core still uses Convex Auth only to mint
  and refresh tokens.
- **Rejected: keep the shared session and stop it from being deleted.** Keeping every refresh
  token of the shared session lets a key that signs in on every run grow tokens without bound.
  Intercepting Convex Auth's refresh to skip the delete ties the core to Convex Auth's internals
  and still lets one client's sign-out end the others.
- **Password and device code sessions do not share this fault.** A password sign-in opens its own
  session. A device code signs one device into one session, and only retries of that code share
  it. Nothing deletes a single refresh token of a live session. Ending a session deletes all of
  them, and the sweep deletes only expired tokens, which outlive their session.

## Account sign-ins (amended 2026-11-04)

Three ways to get in also make or reset an account: first-run setup, accepting an invite, and
redeeming a reset link (ADR 0003). Each is a provider of its own in `convex/core/auth/flows.ts`.

| Provider | Params                         | What it does                              |
| -------- | ------------------------------ | ----------------------------------------- |
| `setup`  | `{ username, password }`       | makes the owner while the server has none |
| `invite` | `{ code, username, password }` | makes the user an invite code asks for    |
| `reset`  | `{ code, password }`           | sets the password a reset link allows     |

- **One call, one hash, one transaction.** Each provider refuses a dead credential before any
  hashing, through `core.server.info` or a public link lookup. It hashes the new password once,
  then calls one internal mutation in `convex/core/accounts/`. That mutation checks the
  credential again, makes or resets the account, uses up the link, and opens the session through
  `openSession`. Convex Auth still only mints tokens.
- **Measured.** Accepting an invite, from the call to holding tokens, has a p50 of 154.1 ms at the
  head and 153.1 ms for old movies' sign-up with an invite code. Those are medians of 5 runs of 50
  accepts a side, with the sides interleaved. Both spend about 135 to 140 ms in one pure-JS Scrypt
  hash, and the core's account steps take about 10 ms of the rest.
- **Held scopes follow the role.** `admin` is the second credential scope (ADR 0005). A password
  session holds every scope its user's role may hold. A key or device session holds its grant cut
  down to those on every call, so a promotion takes effect on the next call. A demotion bumps both
  of the person's generations through `endUserCredentials`, which ends every session and key at
  once, because a grant only cut down would come back with a later promotion.
- **API keys.** A command declared `refusesKeys` refuses API-key sessions (ADR 0009). These
  commands create a key, approve a device, make a user, a link, a role change, or a handover, or
  change the caller's username or password. A device session is not refused. A password session
  approves it with a subset of its scopes, `core.auth.sessions.endAll` ends it, and the CLI signs
  in with one to run `media admin`.
- **Users from the host.** `core/auth/password:createUser` moved to
  `core/accounts/host:createUser`, next to `core/accounts/host:resetPassword`.

Rejected:

- Account commands followed by a password sign-in. Accepting an invite would take two calls and
  two Scrypt runs, about twice the measured p50.
- One `password` provider with a `flow` param. Its params would be a union, and the sign-in
  bucket's rules would sit beside flows that must not take from it.

## The core's store in front of Convex Auth's (amended 2026-11-09)

Convex Auth 0.0.96 reads every refresh token of a session in one call in four places:
`auth:signOut`, a refresh with a token that is expired or whose session is gone or expired, a
refresh with a used token past its 10-second reuse window (it walks every token descended from it),
and a sign-in that replaces the caller's session. A session gathers thousands of tokens over 30
days, and one call may read 4,096 rows, so each failed for a long-lived session, and a reused
token past the window left its session unrevoked.

- **Decision.** The library calls its store by name, `auth:store`. The core exports its own
  `store` there (`convex/auth.ts`, logic in `core/auth/store.ts`) and the library's at
  `auth:libraryStore`. The core's store takes only the calls the core's flows make: a sign-in that
  names its session (every provider opens its own, so the fourth path is unreachable), a sign-out,
  and a refresh. It refuses email, OAuth, and account calls as arguments.
- **Sign-out** ends the caller's session through `endSession`.
- **Refresh.** Before the library sees one, the store answers the cases that read every token:
  - an expired token, or one whose session is gone or expired, ends its session through
    `endSession` and refreshes nothing;
  - a used token past the reuse window, unless it is the parent of the active token, refreshes
    nothing, and every token descended from it is marked used, as the library marks them. The
    session and its other branches go on, so a client whose late network retry came back keeps the
    branch it holds. The store marks 256 tokens a call, depth first over the parent index, and
    schedules the rest (`core/auth/store:invalidateTokens`). Until the last call, a deep token of
    that branch can still refresh once; what it mints is a child in the branch, which a later call
    marks;
  - a token that is gone, or whose stored session differs from the one it names, refreshes
    nothing and ends nothing. It proves no hold on the session it names, where the library ended
    that session, so knowing a session id and holding any refresh token signed its owner out.

  The rest go to the library's store through `ctx.runMutation`, in the same transaction.
  Marked tokens stay until their session ends, so `core.auth.sessions.revoke` still takes any
  token of a session, an invalidated one included.

- **A used token is answered as the library answers it.** Convex Auth calls the session's newest
  unused token active. It hands that token back when the reused token is its parent; otherwise,
  inside the window, it mints a child of the reused token, and past it, it refreshes nothing and
  marks the branch. The store reaches the same answer within a bound:
  - it reads the reused token's children through `sessionIdAndParentRefreshTokenId`, at most 64.
    A late retry with no unused child cannot be handed the active token, so it marks the branch
    without searching further;
  - otherwise it searches for the active token as the library does, from the newest token down to
    the first unused one, at most 1,500 deep. Used tokens lie above the active one only where a
    branch was marked, so the search usually reads one row. When the store then hands the refresh
    to the library, the library's own search reads no more than the store's did;
  - when the active token lies deeper, the library's search could pass the read limit. Wherever
    the library could return a token (inside the window, or past it when the reused token has an
    unused child), the store adds a fresh child of the reused token and hands the library that
    one. On a first use the library reads only the token and its session, so the client gets
    tokens where the library would give them, and they stay in the reused token's branch, which a
    later late retry of it marks.
- **One chain of deletions per session.** `endSession` leaves a session that is already gone
  alone. Whatever deleted it deletes its tokens or leaves them to the sweep, so an expired token
  sent again while its session's tokens are being deleted, or a second revoke, starts no second
  chain.
- **Rejected: patching or forking the library.** The pinned package stays as published, and the
  store depends only on its store's call shapes and two constants it does not export (the reuse
  window and the token divider), which `test/core/auth/store.test.ts` checks against the
  installed package.
- This narrows the rejection above of intercepting Convex Auth's refresh. Since every client has
  its own session, the store does not skip a delete; it does in batches what the library does in
  one call, apart from the two refusals above.
