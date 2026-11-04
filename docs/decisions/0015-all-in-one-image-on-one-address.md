# 0015. Ship one all-in-one image on one address, with the account client at the root

- Status: Accepted, 2026-11-03
- Decisions: D30, D31

## Context

Movies deploys with Docker Compose, a Convex backend container next to the media service, which
publishes two ports and also serves the web app. Its NixOS module runs hardened native systemd
units. Music ships a single-origin all-in-one image. Both claim port 8080, `/data`, `/media/*`, and
`/invite/:code`.

With one account system across products, sign-in, the picker, invites, device approval, and admin
belong to no single product.

## Decision

- **The all-in-one image is the product.** It runs Convex, the server, and Caddy under s6, on one
  port and one address.
  - `/convex` is the Convex backend.
  - `/api` and `/media` are the server.
  - Clients are served from `/`.
- **Compose** only adds optional sidecars around the image.
- **NixOS** runs hardened native units, from movies' module.
- **Web addresses.**
  - A shared account client at `/` holds sign in, the picker, invites, device approval, and admin.
    It links to `/movies` and `/music`.
  - The platform routes `/invite/:code`, `/device`, and `/reset/:token` belong to the account
    client.

## Consequences

- An install exposes one port, and every web client shares one origin (ADR 0020).
- `/invite/:code` exists once, so the two products' clashing routes resolve to one.
- Convex Auth's HTTP routes run on Convex's HTTP actions origin, which the path list does not
  place yet (`docs/architecture.md`, "Open").
- The Compose file shrinks to the image plus optional sidecars. The two-port Compose layout goes.
- The NixOS module keeps movies' hardened native units instead of running the image.

## Alternatives rejected

- Movies' two-port Compose layout as the product. The all-in-one image replaces it.
- Each product client owning its own invite, device, and reset routes. The account client owns
  them.

## Edge cases settled

- `/` is the account client, not a product client.
- `/device` serves device approval for every client.
- Sidecars are optional. The image runs alone.
