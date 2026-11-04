# [media] architecture

[movies] and [music] become one self-hosted product, `[media]`. One server, one Convex database, and
one account system serve a separately branded client per product. This page describes the target
after the music port lands, the rules that hold it together, and the order of work. The decisions
behind it are in [`docs/decisions/`](decisions/), one record per area, each citing the
decision numbers (D01 to D44) settled with the owner on 2026-11-03.

`docs/decisions.md` records how movies is built today. It stays accurate for the old movies code
until the movies port replaces that code.

## One product on one server

The owner runs one install for the household. It holds one set of users, and each user sees movies
and music through their own client. Domains are always on. A domain with no libraries runs no
workers, and its crons do no work. Later products such as photos or books get a library `kind`, job
kinds, and a command group. The core has no generic machinery for them (ADR 0002).

The install is one all-in-one image with Convex, the server, and Caddy under s6, on one port and
one address (ADR 0015). Media mounts are read-only. A fresh install rescans them in full, and
nothing comes over from the old databases.

## Layout

The tree shows the repo once movies and music both run on the core.

```text
apps/
  web-account/        account client at /: sign in, picker, invites, device approval, admin
  web-movies/         movies web client at /movies, Netflix look
  web-music/          music web client at /music, Apple Music light, Spotify dark
  mobile-movies/      movies iOS app over @media/mobile-core
  mobile-music/       music iOS app over @media/mobile-core
  media/              @media/server: Effect HttpApi, worker pools, ffmpeg children
  cli/                the `media` binary and the agent skill, one reference file per domain
packages/
  platform/convex/
    core/             identity, permissions, devices, guests, jobs, libraries, settings,
                      downloads, together, connect
    movies/           titles, files, metadata, the Jellyfin and Plex importer
    music/            tracks, albums, playlists, lyrics
  platform/commands/  generated command contracts that each Convex module registers
  commands/           the command list and its generator
  contracts/          Effect Schema DTOs, errors, the server's HttpApi
  sdk/                Effect core with /effect, /react, /promise entry points
  mobile-core/        shared iOS app code, including the shared keychain sign-in
  ui/                 shared shadcn base and type scale
  config/             shared strict tsconfig
deploy/               the all-in-one image; Compose adds optional sidecars
nix/                  NixOS module with hardened native units
legacy/music/         old music code, runnable until the music port lands, then deleted
```

The server keeps its folder, `apps/media`, under the package name `@media/server`. Moving it to
`apps/server` would only rewrite the paths that the Dockerfile, the Nix packages, CI, the scripts,
and the docs name, with no change in behavior.

## Core modules

The core lives in `packages/platform/convex/core`, plus the server code that serves bytes and runs
jobs. Each module is used by every domain. Until the movies port, `packages/platform` runs as its
own Convex deployment next to old movies' `packages/backend` (ADR 0023).

| Module      | Holds                                                                                     | ADR        |
| ----------- | ----------------------------------------------------------------------------------------- | ---------- |
| Identity    | Users, usernames, passwords, sessions, API keys, device codes, invites, reset links       | 0003, 0004 |
| Permissions | Platform roles, credential scopes, the grants table, groups, content restrictions         | 0005       |
| Devices     | The device registry, personal and shared devices, the picker, locks, unlock codes         | 0006       |
| Guests      | Guest principals, share links, the admin switch, the guest address, rate limits           | 0007       |
| Commands    | `packages/commands` and the generator for Convex functions, SDK, CLI, menu, and skill     | 0009       |
| Tickets     | One signed-URL format for every byte-serving route, with key ids and live revocation      | 0011       |
| Jobs        | Job kinds, typed payloads, leases, attempts, per-kind caps, `schemaMigrations`, `imports` | 0012       |
| Limits      | Pagination by index, counter tables, batched writes                                       | 0013       |
| Libraries   | Libraries with a `kind`, their folders, and the grants that share them                    | 0002, 0005 |
| Settings    | The table that marks each setting as synced per user or kept per device                   | 0019       |
| Downloads   | Who may download, per-device item lists, storage caps, re-sync, expiry on revocation      | 0019       |
| Together    | Group sessions with join links, roles, join settings, presence, and a shared clock        | 0017       |
| Connect     | Remote control, loose sync, Chromecast and AirPlay targets, control rules                 | 0018       |

## Domains

Each domain is a folder in one Convex schema, not a Convex component (ADR 0008). A domain owns its
catalog tables, its scanner callbacks, its share of the command list, and the state it supplies to
group sessions and downloads.

- **Movies** owns titles, files, metadata, trickplay, and the Jellyfin and Plex importer. Its
  clients are `apps/web-movies` and `apps/mobile-movies`.
- **Music** owns tracks, albums, playlists, lyrics, crossfade, and gapless playback. Its clients
  are `apps/web-music` and `apps/mobile-music`.

Each client searches its own catalog only (ADR 0020), and runs group sessions for its own domain
only (ADR 0017).

## Ownership rules

- **Convex owns product state.** Users, credentials, grants, devices, libraries, catalog rows,
  jobs, settings, downloads, history, and session state live in Convex.
- **Disk owns original media, and it is read-only.** The server reads library files and never
  writes to a media mount.
- **The server owns streams.** Per-device streams, ffmpeg processes, worker pools, and temporary
  segments belong to `@media/server`. One server-wide transcode limit covers every domain, and each
  domain has its own worker caps (ADR 0014).
- **Convex never calls the server.** The server signs in as a service principal with a scoped API
  key and subscribes outward (ADR 0010).
- **Every access check confirms a live session.** A JWT alone is not enough (ADR 0004).
- **Admins manage accounts, not content.** A private resource stays invisible to admins in the
  apps (ADR 0005).
- **Clients stay clean.** The SDK core has no Node filesystem or DOM imports. Server and backend
  modules never reach browser bundles.

## One address

The image serves every path from one port.

| Path            | Served by                                               |
| --------------- | ------------------------------------------------------- |
| `/`             | `apps/web-account`                                      |
| `/invite/:code` | `apps/web-account`, accepting an invite                 |
| `/device`       | `apps/web-account`, approving a device code             |
| `/reset/:token` | `apps/web-account`, a one-time reset link               |
| `/movies`       | `apps/web-movies`                                       |
| `/music`        | `apps/web-music`                                        |
| `/convex`       | the Convex backend                                      |
| `/api`          | `@media/server`, its HttpApi routes                     |
| `/media`        | `@media/server`, byte-serving routes that take a ticket |

Guest links use a configurable guest address. v1 runs on the home network or Tailscale, and
Tailscale Funnel can open guest links (ADR 0007).

## Order of work

Each phase ends in merged PRs. A port deletes the old code it replaces before its phase closes.
Phase 3 builds each core module. Phases 6 and 7 put together, Connect, casting, and guests into
the clients. The owner's installs keep running the old products until the fresh install in phase
8, so a feature that a port deletes and a later phase brings back, such as watch rooms or
casting, is missing only from the repo in between.

0. **Freeze.** Land or close open PRs, audit branches, and write these docs.
1. **Repo merge.** Import music's history into `legacy/music/`, rename `lmdevv/movies` to
   `lmdevv/media`, archive `lmdevv/music`, and clean up local folders once the import is verified.
2. **Shared tooling.** Merge `CLAUDE.md`, rename the scope and settings, scope CI and lefthook to
   changed packages, carry pstack over, build `verify-media` and the combined demo image, and align
   versions.
3. **Core.** Build identity, permissions, devices and locks, tickets, jobs, libraries, settings,
   downloads, together, connect, guests, the command generator, the SDK core, `apps/web-account`,
   the CLI shell, and the deploy image.
4. **Movies port.** Move the web app, the iOS app, the CLI commands, and the importer onto the core.
   Move movies into `packages/platform/convex/movies/`. Delete the old movies code and
   `packages/backend`.
5. **Music port.** Move the web app, the iOS app, the CLI commands, gapless playback, and lyrics
   onto the core. Delete `legacy/music`.
6. **Together, Connect, and casting** in both products' clients.
7. **Guests and share links.**
8. **Fresh install** on the owner's NAS against the same mounts.
9. **Linear triage** and backlog filing from the list the owner approves.

## Decision records

Each row is the ADR's own title.

| ADR                                                                                | Decision                                                                      | D-numbers     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| [0001](decisions/0001-one-repo-named-media.md)                                     | Merge both products into one repo named [media]                               | D08, D09, D10 |
| [0002](decisions/0002-build-a-new-core-and-start-fresh.md)                         | Build a new platform core and start from a fresh install                      | D01 to D07    |
| [0003](decisions/0003-users-sign-in-with-username-and-password.md)                 | Make every account a user who signs in with a username and password           | D12, D13, D15 |
| [0004](decisions/0004-convex-auth-v1-behind-an-interface.md)                       | Use Convex Auth v1 behind a thin interface and check every session live       | D14           |
| [0005](decisions/0005-four-permission-layers-and-kids.md)                          | Check access in four layers and make kids restricted users                    | D16, D17      |
| [0006](decisions/0006-device-registry-and-shared-device-locks.md)                  | Register every device and lock adult tiles on shared devices                  | D18, D19      |
| [0007](decisions/0007-guest-links-on-the-home-network.md)                          | Build guests into identity and keep v1 on the home network or Tailscale       | D20, D21      |
| [0008](decisions/0008-domains-are-folders-in-one-schema.md)                        | Keep each domain as a folder in one Convex schema                             | D22           |
| [0009](decisions/0009-command-list-generates-every-entry-point.md)                 | Declare each action once and generate its Convex function and clients         | D23           |
| [0010](decisions/0010-effect-httpapi-server-with-a-service-principal.md)           | Serve HTTP with Effect HttpApi and sign the server in as a service principal  | D24, D25      |
| [0011](decisions/0011-one-ticket-format-for-every-byte.md)                         | Use one signed ticket format for every route that serves bytes                | D26           |
| [0012](decisions/0012-one-job-framework.md)                                        | Run all background work through one job framework in the core                 | D27           |
| [0013](decisions/0013-stay-inside-convex-per-call-limits.md)                       | Keep SQLite and build every list to stay inside Convex's per-call limits      | D28           |
| [0014](decisions/0014-one-server-process-with-per-domain-budgets.md)               | Run one server process with per-domain worker caps and one transcode limit    | D29           |
| [0015](decisions/0015-all-in-one-image-on-one-address.md)                          | Ship one all-in-one image on one address, with the account client at the root | D30, D31      |
| [0016](decisions/0016-one-config-shape-and-aligned-versions.md)                    | Use one config shape and align dependency versions                            | D32, D33      |
| [0017](decisions/0017-one-group-session-feature.md)                                | Build group sessions once in the core and let each domain supply its state    | D34           |
| [0018](decisions/0018-connect-remote-control-and-casting.md)                       | Put remote control and casting in the core and keep third-party support small | D35, D44      |
| [0019](decisions/0019-synced-settings-and-core-downloads.md)                       | Mark which settings sync per user and run downloads as a core service         | D36, D37      |
| [0020](decisions/0020-branded-clients-with-one-sign-in.md)                         | Ship a branded client per product on a shared base, with one sign-in          | D38, D39, D40 |
| [0021](decisions/0021-one-cli-and-one-agent-skill.md)                              | Ship one `media` CLI and one agent skill with a reference per domain          | D41           |
| [0022](decisions/0022-agent-workflow-tracking-and-copyleft.md)                     | Keep movies' agent workflow, one Linear team, and a merged copyleft list      | D11, D42, D43 |
| [0023](decisions/0023-run-the-core-in-its-own-deployment-until-the-movies-port.md) | Run the core in its own Convex deployment until the movies port               | D04, D14, D22 |

## Open

The decisions register leaves these open. Each is settled in the phase named, and the result gets
an ADR.

- **Per-user personalization.** The register settles which settings sync per user and which stay
  per device (ADR 0019). It does not settle personalization beyond that list.
- **The exact shared UI split.** Each product has its own look on a shared shadcn base and type
  scale. Which components are shared and which belong to one product is decided in Paper during
  the ports (ADR 0020).
- **Where Convex's HTTP actions live on the one address.** Convex Auth serves its sign-in routes
  and its JWKS from Convex's HTTP actions origin, a separate port in today's dev stack. The
  register names `/convex` for Convex and `/api` for the server and does not place that origin.
  The deploy image PR in phase 3 settles it.
- **How a Cast receiver renews its ticket.** Personal tickets last up to 6 hours, and a receiver
  keeps the URL it was given (ADR 0011). The tickets PR in phase 3 settles it.
- **How a locked unlock code recovers.** The code locks after 5 wrong tries, and the register does
  not say how it unlocks again (ADR 0006). The devices PR in phase 3 settles it.
- **What the shared iOS keychain stores.** Each app mints its own session from the shared
  keychain (ADR 0020). The register does not say which credential the keychain holds or what
  signing out of one app does to the other. The movies port settles it with `@media/mobile-core`.

## Appendix A. Where the core runs until the movies port

Old movies keeps running until the movies port (ADR 0002), and both it and the core use Convex
Auth. Convex Auth's tables and its `auth:store` function have fixed names, so one deployment holds
one Convex Auth setup. Two throwaway prototypes tried the two ways to run the core next to old
movies. Prototype B won, and ADR 0023 records the decision.

| Question                                | A. Core in the movies deployment                                                                                                            | B. Core in its own deployment (chosen)                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Branch                                  | `media/p3-core-layout-proto-a`                                                                                                              | `media/p3-core-layout-proto-b`                                                                                                    |
| Commit                                  | `2895b02d11f211f86760584e0167b4314b7bcd2e`                                                                                                  | `388e3392c7575a368afdbbae072fff7b9cf5f615`                                                                                        |
| Old movies' backend stack suite         | 253 passed, 1 skipped, at the commit above                                                                                                  | 252 passed, 1 skipped, with old movies code unchanged                                                                             |
| Old movies code changed                 | `schema.ts`, `auth.ts`, `authParams.ts`, and the test harness                                                                               | None                                                                                                                              |
| Core `users` and `authSessions`         | `username` optional, the `service` role, and movies' email, grant, and profile unlocks kept as compatibility fields                         | Only core fields, with `username` required and the roles owner, admin, member, and guest                                          |
| Strict core shape on old movies         | 40 type errors in 12 backend files, and 54 client, server, and test files mention email                                                     | Not applicable                                                                                                                    |
| Sign-in isolation                       | A user from the core's username provider got a working movies session without movies' invite check                                          | Old movies refused a core session token                                                                                           |
| Name clashes left for later phase 3 PRs | 7 tables (`users`, `authSessions`, `apiKeys`, `deviceCodes`, `invites`, `jobs`, `libraries`), plus one `auth.ts`, `crons.ts`, and `http.ts` | None                                                                                                                              |
| End of the movies port                  | Delete every compatibility field, then move movies into `convex/movies/`                                                                    | Move movies into `packages/platform/convex/movies/`, delete `packages/backend` and the second dev-stack backend                   |
| Dev stack on this host                  | One backend                                                                                                                                 | A second backend that idles at 46 MiB. A cold `up` takes 8.7 s against 6.7 s (medians of 3, interleaved), and a core deploy 0.9 s |
| Repo wiring                             | None                                                                                                                                        | `knip.json`, `vitest.config.ts`, `.oxfmtrc.json`, `oxlint.config.ts`, the hook's routing and its test, CI, version                |

Each prototype has a probe test on its branch: `packages/backend/test/proto-a-probe.test.ts` and
`packages/platform/test/proto-b-probe.test.ts`. Run one with `MEDIA_STACK_TESTS=1` after
`scripts/dev-stack.sh up` on its branch.

B costs a few seconds and tens of MiB per worktree, plus one-time wiring. A costs compatibility code
in the core's own tables, which every later phase 3 PR would grow and the movies port would have to
delete. At the movies port, B leaves `packages/backend`, its dev-stack backend, and its config
entries to delete, and no code inside the core changes.

The build on top of B found two facts that shaped the helpers:

- A counter kept in one row lost increments under load. With 20 concurrent increments, Convex
  gave up retrying about once in ten runs (3 failures in 30) with
  `OptimisticConcurrencyControlFailure`. `core/lib/counters.ts` spreads each counter over 16 shard
  rows. The core's stack suite then passed 30 runs out of 30, 50 more races of 20 concurrent
  increments all ended at 20, and 20 increments landed on 12 to 16 shards.
- `paginate` reads no more rows than it returns. On the dev stack, a 100-row page read 100
  documents, and a request for 50,000 rows returned 1,000 rows after reading 1,000. A version
  that collects the whole range and slices it read 250 documents for a 25-row page, and 1,500 for
  a 1,000-row page, and failed both of the core's read tests.
