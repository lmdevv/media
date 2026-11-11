# 0027. Run one Convex backend, the core's, in the image

- Status: Accepted, 2026-11-10. Supersedes ADR 0026.
- Decisions: D03, D30, D32, D49, D50, D52, D54, D58, D62

## Context

ADR 0026 ran two Convex backends in the image while phase 3 built the core. The core's served the
account client at `/convex`. Old movies' served the movies client, its media service, and the
movies iOS app at `/movies/convex`. Someone who used both clients signed in twice, and the second
backend took idle memory from 356 MiB to 562 MiB. The owner accepted both only until the movies
port (D54).

By `p4-movies-cutover`, movies lives in `packages/platform/convex/movies/`, the server has its core
adapters (ADR 0010), and the movies web client can run on the browser's one session (ADR 0020).
The cutover switches the server, the movies web client, and the image in one change, so the
running server never holds two Convex URLs (D50).

## Decision

- **The image runs one Convex backend under s6, the core's.** Its API listens on 127.0.0.1:3210
  and its HTTP actions on 127.0.0.1:3211 (ADR 0025). The `convex-movies` service and
  `/app/backend` are gone from the image.
- **Routes on the one port (Caddy).**

  | Path                         | Served by                                                             |
  | ---------------------------- | --------------------------------------------------------------------- |
  | `/`                          | the account client, from files                                        |
  | `/convex`                    | the core's Convex API                                                 |
  | `/movies`                    | the media service, which serves the movies client built for `/movies` |
  | `/movies/convex`             | nothing: Caddy answers `404 Not Found`                                |
  | `/api`, `/media`, `/artwork` | the media service                                                     |

- **Init deploys `packages/platform` only.** At every start, as root, it derives the core's admin
  key from the backend's instance secret, backs up before an upgrade, deploys the core's
  functions, and runs the core's `configure.ts` and its schema migrations.
- **Init gives the media server its own service principal and key.**
  - On the first start, init creates the principal with `core/accounts/host:createService` and
    records its id in `/data/core/secrets/media-service-id`.
  - Init issues the key with `core/auth/apiKeys:issueServiceKey` into
    `/data/core/secrets/media-service-key`, which only root can read. The key goes from the
    Convex CLI's output into the file, never onto a command line or into the log.
  - Later starts reuse the file. If the file is lost, init issues a new key to the same principal,
    and that key's first sign-in retires the old one (ADR 0010).
  - If issuing fails, as when a restored database does not hold the recorded principal, init
    creates a new principal and issues its key.
- **Init reads `MEDIA_TICKET_KEYS` from the core deployment** with `convex env get`. The core's
  `configure.ts` sets it once. Init stops if it is empty.
- **The server's settings now mean the core.**

  | Setting                        | Means                                                                 |
  | ------------------------------ | --------------------------------------------------------------------- |
  | `CONVEX_URL`                   | the core's Convex URL, `http://127.0.0.1:3210` in the image           |
  | `CONVEX_PUBLIC_URL`            | the core's URL as clients reach it, `MEDIA_BASE_URL/convex`           |
  | `MEDIA_SERVICE_API_KEY`        | the key the core issued the server's service principal                |
  | `MEDIA_TICKET_KEYS`            | the core's ticket key ring, the same value as the core deployment's   |
  | `CONVEX_SELF_HOSTED_ADMIN_KEY` | the core's admin key, for backups and restores                        |
  | `CONVEX_BACKEND_DIR`           | the deployed `packages/platform` folder, `/app/platform` in the image |

  `PLAYBACK_TOKEN_SECRET` is removed. With `CONVEX_URL` set, the server refuses to start without
  `MEDIA_SERVICE_API_KEY` or without `MEDIA_TICKET_KEYS`, and names the missing one.

- **Backups live in `/data/core/backups`, owned by the media user**, because the media service
  takes and restores them. `/data/movies` keeps the media service's state (`media/`) and the image
  CLI's logins (`config/`).
- **Both web clients reach the core at `MEDIA_BASE_URL/convex`.** Init writes that URL into its
  copy of each client.
- **`/api/client-config` reports `convexUrl` and `moviesUrl`.** `convexUrl` is the core's public
  URL, and `moviesUrl` is `MEDIA_BASE_URL/movies`, so links the iOS app builds, such as a title's
  share link, open the movies client and not the account client.
- **The NixOS module does the same (D58).** It runs one OCI container, `media-core-convex`. Its
  setup creates the principal and issues the key into `dataDir/core/secrets` the same way.
  `backupDir` defaults to `dataDir/core/backups`, owned by the service user.
  `internalPorts.moviesConvex` is removed, and setting it fails with a message.
- **Fresh installs only.** Nothing migrates a v0.2 install's data (D03). An install of the image
  from before the cutover keeps old movies' database in `/data/movies/convex` and its backups in
  `/data/movies/backups`, and nothing reads them.

## Idle memory

The owner's rule (D54) holds the image to 356 MiB idle and to no more than the `v0.2.0` stack.
With defaults, the image sat at about 450 MiB. The core's Convex backend held about 215 MiB of
anonymous memory, the media service about 190 MiB, and Caddy 11 MiB. Three settings bring the
image under the rule. They change no product behavior, and both install methods use them.

- **The media service runs without `--enable-source-maps`.** Node parses the bundle's 14 MB
  source map at start and keeps it, about 100 MiB. Stack traces in the log now point at
  `dist/main.js` lines with the bundle's function names, not at `src/*.ts`. The map still ships
  next to the bundle for reading a trace offline. `pnpm dev`, `pnpm start`, and the test stacks
  keep source maps.
- **`MALLOC_ARENA_MAX=2` for the media service and the Convex backend.** glibc gives each thread
  its own malloc arena. The backend runs one Tokio worker and one V8 thread per core, plus a
  thread per isolate, and each arena keeps freed memory. Two arenas saved about 40 MiB in the
  backend and about 10 MiB in Node.
- **`ISOLATE_IDLE_TIMEOUT_SECONDS=60` for the Convex backend.** The default is 600. The backend
  keeps an isolate per worker thread it has ever needed, each holding the core's loaded modules
  and heap. After a minute idle, an isolate is recreated empty, which saved 70 to 75 MiB. The
  next function on that worker loads the modules again, a one-time cost of milliseconds. The
  core's 10-second crons keep the isolates they use warm.

Not used: concurrency caps (`MAX_ISOLATE_WORKERS`, `RUNTIME_WORKER_THREADS`, `V8_THREADS`,
`APPLICATION_MAX_CONCURRENT_*`), because the idle knobs were enough; a smaller V8 young
generation (`--max-semi-space-size=8`), whose 10 MiB or less was within run-to-run noise and
costs more scavenges during scans; a cap on Node's old space, which risks an out-of-memory crash
during a large scan; and Go knobs for Caddy, whose anonymous memory is 11 MiB. The receipt is
`captures/verify/p4-movies-cutover/perf-2.md`.

## Consequences

- Signing in once at `/` signs `/movies` in too (ADR 0020).
- The old movies iOS app and the CLI's old top-level words, such as `media search`, `media play`,
  and `media backups`, cannot reach the image. They call old movies' functions, which the core
  does not serve. `p4-mobile-movies` moves the iOS app onto the core, and `p4-movies-cli` the CLI
  words.
- After restoring an older backup, the server may hold a key that the restored database does not
  know, and it cannot sign in (ADR 0010, "The server on the core"). On the image, delete
  `/data/core/secrets/media-service-key` and restart the container. Init then issues a new key.
- A new service key makes earlier artwork keys and the importer's sealed credentials unreadable,
  because both are sealed under the key (ADR 0010). A rescan or a metadata refresh writes new
  artwork keys.
- `packages/backend` stays in the repo for its own stack tests until `p4-movies-delete`. The dev
  stack still runs its backend on the base port, and the media server and both web clients use the
  core.

## Acceptance

The owner's deferred acceptance from #123 (D54) binds this change: the image's idle memory must be
at or below the `v0.2.0` Compose stack's 356 MiB. The probe is `docker stats` summed over the
project's containers after 5 idle minutes, the median of five runs interleaved with the `v0.2.0`
stack. With the settings under "Idle memory", the image measured 187.5 MiB against `v0.2.0`'s
354.1 MiB on 2026-11-10 (`captures/verify/p4-movies-cutover/perf-2.md`).

## Alternatives rejected

- Keeping old movies' backend in the image until `p4-movies-delete`. It holds the memory the owner
  accepted only until the movies port, and an account system that no client signs in to.
- Taking the service key from an operator setting. A first start would then need a manual step.
  Init issues the key once and keeps it.
- Issuing a new key at every start. Artwork keys are sealed under the service key, so every
  restart would make every artwork key the core holds unreadable.
- Keeping `/movies/convex` as an alias of `/convex`. No client is built with it. An old iOS app
  would reach a backend that does not serve its functions, and a plain `404` says so sooner.

## Edge cases settled

- `/movies/convex` and every path under it answer `404 Not Found` from Caddy, not the movies
  client's page.
- No command line holds the Convex instance secret, in the image or under the NixOS module: both
  start the backend and run `generate_key` through the argv-secret shim, and the module replaces
  the upstream entrypoint with `nix/convex-entry.sh` (docs/security.md).
- `/music` is still not served until the music port, as under ADR 0026.
- An upgrade backup is `core-manual-<timestamp>.zip` in `/data/core/backups`, owned by the media
  user, so the media service lists and restores it.
- A restart reuses the stored key. `scripts/stack-e2e.sh` checks that, that the key and the
  ticket keys stay out of the container's log, and that a lost key file gets a new key for the
  same principal.
