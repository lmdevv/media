# 0025. Keep Convex's HTTP actions inside the install, off the public address

- Status: Accepted, 2026-11-08
- Decisions: D30, D45

## Context

A self-hosted Convex backend answers on two ports. The API port serves queries, mutations,
actions, the sync WebSocket, and the admin API. The HTTP actions port, which Convex calls the site,
serves the routes in a project's `convex/http.ts`. ADR 0015 puts the API at `/convex` on the one
address and leaves the HTTP actions origin unplaced (`docs/architecture.md`, "Open").

Both Convex projects use HTTP actions only for Convex Auth. `auth.addHttpRoutes` adds two routes:
`/.well-known/openid-configuration` and `/.well-known/jwks.json`. Convex Auth signs each session
token with the deployment's `CONVEX_SITE_URL` as its issuer, and `auth.config.ts` names that URL as
the provider's domain. To verify a token, the backend fetches the discovery document and the JWKS
from that URL itself. No client and no server calls either route. Clients sign in by calling
`auth:signIn`, a Convex action, over the API.

Old movies' Compose file and NixOS module already set the site origin to
`http://127.0.0.1:3211`, inside the backend's container, and old music's image did the same.

## Decision

- **Each backend's HTTP actions origin is its own loopback address, inside the install.** The
  core's is `http://127.0.0.1:3211` and old movies' is `http://127.0.0.1:3221` in the image. The
  NixOS module keeps each backend's origin inside its container.
- **The public address has no path for HTTP actions.** Caddy routes `/convex` to the core's API
  port only, and `/movies/convex` to old movies' API port only.
- **A feature that needs a public HTTP action adds its own path** under `/convex`, with an ADR, at
  that time.

## Consequences

- A session token's issuer is a loopback URL. Only the backend that issued the token verifies it,
  and it reaches that URL. The media service never verifies Convex tokens itself; it signs in with
  its own credential (ADR 0010).
- Moving the install to another public URL changes no token issuer, so a URL change signs no one
  out.
- The JWKS is not published. A third party cannot verify a [media] session token, and none needs
  to.
- `scripts/stack-e2e.sh` checks that `/convex/.well-known/jwks.json` does not answer with keys,
  while the core's JWKS answers inside the container.

## Alternatives rejected

- A public site path, such as `/convex-site`, with `CONVEX_SITE_URL` set to it. It adds a route
  that no client calls, makes token verification depend on the public URL and the proxy, and
  signs everyone out when the public URL changes.
- Serving the site port at `/convex` beside the API. The two ports' paths can collide, and Convex
  serves them from separate ports for that reason.

## Edge cases settled

- `scripts/dev-stack.sh` publishes each backend's site port on the host (base + 1 and base + 5)
  with a matching `CONVEX_SITE_ORIGIN`, so that the backend can reach its own origin from inside
  its container. That serves the same purpose and is not a public route.
- Convex Auth's OAuth callback routes need a public HTTP action. ADR 0003 rules out SSO, so no
  provider needs one.
