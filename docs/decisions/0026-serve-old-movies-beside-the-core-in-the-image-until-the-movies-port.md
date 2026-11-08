# 0026. Serve old movies beside the core in the image until the movies port

- Status: Accepted, 2026-11-08
- Decisions: D30, D31, D32, D49, D50

## Context

ADR 0015 makes the all-in-one image the product: Convex, the server, and Caddy under s6 on one
port, with `/convex`, `/api`, `/media`, the account client at `/`, and the product clients at
`/movies` and `/music`. In phase 3 the parts that exist are these:

- The core is its own Convex project, `packages/platform`, with its own deployment (ADR 0023). The
  account client at `/` talks only to it.
- Old movies keeps `packages/backend` and its deployment. Its media service and web app talk only
  to it, and phase 3 never wires them to the core (D50).
- Old music runs from `legacy/music` with its own Convex deployment, its own media service, which
  also claims `/media`, and a web app built for `/`. `apps/web-music` does not exist until the
  music port.

Before this, the image held only old movies' media service, and Compose ran Convex beside it on a
second port.

## Decision

- **The image runs two Convex backends under s6.** The core's API listens on 127.0.0.1:3210 and
  old movies' on 127.0.0.1:3220, each with its HTTP actions on the next port (ADR 0025). Init
  deploys and configures both at every start. Each backs up its deployment before an upgrade.
- **Routes on the one port (Caddy).**

  | Path             | Served by                                                             |
  | ---------------- | --------------------------------------------------------------------- |
  | `/`              | the account client, from files                                        |
  | `/convex`        | the core's Convex API                                                 |
  | `/movies`        | the media service, which serves the movies client built for `/movies` |
  | `/movies/convex` | old movies' Convex API                                                |
  | `/api`, `/media` | the media service                                                     |
  | `/artwork`       | the media service's artwork route, which the movies client calls      |

- **`/music` is not served in phase 3.** A request for it reaches the account client, which shows
  its own not-found page. The music port builds `apps/web-music` and adds the route. Old music
  keeps running from `legacy/music`, outside the image.
- **One data root with a folder per domain.** `/data/core` holds the core's Convex database and
  its upgrade backups. `/data/movies` holds old movies' Convex database, the media service's state
  (`media/`), nightly and upgrade backups (`backups/`), and the in-image CLI's login (`config/`).
  `/transcode` stays a separate volume for disposable segments.
- **Old movies' links point under `/movies`.** Its deployment's `SITE_URL` is the public URL plus
  `/movies`, so invite and device links open the movies client, not the account client.
- **Compose runs only the image** plus its optional sidecars. The NixOS module serves the same
  paths with the same Caddyfile, in front of both Convex containers and the native media service.

## Consequences

- An install exposes one port. Browsers, the CLI, and the movies iOS app reach old movies'
  Convex at `/movies/convex`, which the media service reports at `/api/client-config`.
- Someone who uses both clients signs in twice in phase 3: once in the account client, against
  the core, and once in the movies client, against old movies. The movies port removes the second
  account system, `/movies/convex`, and the second backend.
- The image runs one more Convex backend and Caddy than the old media service image. It replaces
  the separate Convex image.
- Behind Caddy every request reaches the media service from 127.0.0.1, so its per-address rate
  limits on `/artwork` and `/api/health` count all clients together. The server's adoption of the
  core in phase 4 should trust Caddy's `X-Forwarded-For`.
- A share link the movies iOS app builds from the server URL, `/title/<id>`, lands on the account
  client, not the movies client, until the movies port settles the web URLs.

## Alternatives rejected

- Old music inside the image at `/music`. It needs a third Convex backend, a second media service
  on routes that clash with movies' `/media`, and a base path in `legacy/music`'s web app, all
  deleted by the music port.
- Old movies' Convex at `/convex` and the core's elsewhere. `/convex` is the product's backend
  after the movies port, and the account client at `/` already talks to the core there.
- Keeping Convex in its own Compose service on a second port. ADR 0015 replaces that layout.

## Edge cases settled

- `/movies` without a trailing slash redirects to `/movies/` with a 308.
- The core's version marker and upgrade backups live in `/data/core`, apart from movies', so an
  upgrade that changes only one project's functions backs up only that one.
