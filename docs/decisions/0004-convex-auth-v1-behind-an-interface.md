# 0004. Use Convex Auth v1 behind a thin interface and check every session live

- Status: Accepted, 2026-11-03
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
