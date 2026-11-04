# 0010. Serve HTTP with Effect HttpApi and sign the server in as a service principal

- Status: Accepted, 2026-11-03
- Decisions: D24, D25

## Context

Movies' media service is Node with Effect HttpApi, and its routes are declared in shared contracts
in `packages/contracts`. Music's media service uses Hono.

Movies' media service signs in to Convex through the `apikey` provider with `MEDIA_SERVICE_API_KEY`.
The key belongs to a `service` account, and its grant carries only the `media-service` scope.
Music's media service passes a shared secret (`MEDIA_SERVICE_SECRET`) to Convex as a function
argument. That secret shows in Convex logs, cannot be scoped, and cannot be rotated.

## Decision

- The server's HTTP layer is Effect HttpApi with shared contracts, as in movies. Hono goes.
- The server signs in to Convex as a service principal with a scoped API key, as in movies.
  Music's secret-as-argument goes.

## Consequences

- Clients, the SDK, and the server share one typed description of every HTTP route.
- The server's Convex access is limited to the scopes on its key, and the key can be rotated.
- Music's routes are rewritten onto HttpApi during the music port (phase 5).
- Convex still never calls the server. The server subscribes outward (`docs/architecture.md`).

## Alternatives rejected

- Hono for the server. Effect HttpApi with shared contracts replaces it.
- A shared secret passed as a function argument. It shows in Convex logs, cannot be scoped, and
  cannot be rotated.

## Edge cases settled

- A service principal is a principal type of its own, not a user with a role (ADR 0005).
- A leaked server key reaches only what its scopes allow.
