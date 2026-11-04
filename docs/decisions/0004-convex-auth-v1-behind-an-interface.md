# 0004. Use Convex Auth v1 behind a thin interface and check every session live

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with how sign-in was built, again on
  2026-11-04 to give each API key sign-in its own session, and again on 2026-11-04 with the
  account sign-ins.
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
  - A device code lasts 10 minutes, at most 50 wait at once, and the device polls `auth:signIn`,
    which answers `pending`, `denied`, or `expired` until approval. After approval the code signs
    the device into the same session until it expires, so a lost answer costs only a retry.
- **Cleanup.** Ending a session deletes its refresh tokens. Revoking a key deletes its sessions at
  once and leaves their refresh tokens to the sweep. Ending every session or key deletes the ended
  rows in scheduled batches. An hourly sweep deletes expired refresh tokens, old device codes, and
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
- **Measured.** Accepting an invite, from the call to holding tokens, has a p50 of 152.5 ms at the
  head and 153.5 ms for old movies' sign-up with an invite code. Those are medians of 5 runs of 50
  accepts a side, with the sides interleaved. Both spend about 140 ms in one pure-JS Scrypt hash,
  and the core's account steps take about 12 ms of the rest.
- **Held scopes follow the role.** `admin` is the second credential scope (ADR 0005). A password
  session holds every scope its user's role may hold. A key or device session holds its grant cut
  down to those on every call, so a demotion takes effect on the next call.
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
