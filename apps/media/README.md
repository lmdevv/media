# @media/server

Node + Effect HttpApi media service. It scans approved library folders, probes files with
ffprobe, merges local NFO/artwork with TMDB metadata, negotiates playback, serves direct files
with byte ranges, produces fMP4 HLS (remux, audio-only transcode, Intel QSV or VA-API transcode with HDR
tone mapping, or software transcode capped at 1080p), converts text subtitles to WebVTT, and
hosts the built web app. For music (`src/music/`, from old music's media service) it scans music
folders into the core's catalog with their tags, folder art, and own lyrics, follows moved files,
and streams songs as originals, fast-start AAC, or gapless fragmented FLAC and AAC.

```sh
pnpm --filter @media/server dev        # bundle, watch, and run with .env.local
pnpm --filter @media/server build      # dist/main.js
pnpm --filter @media/server start      # node dist/main.js
pnpm --filter @media/server fixtures /tmp/movies-fixtures   # generated test library
```

With `CONVEX_URL` and `MEDIA_SERVICE_API_KEY` (written by `scripts/dev-stack.sh up`) the service
signs in to Convex as the restricted service account and works from Convex: libraries, files,
titles, jobs, and playback sessions live there (see "Convex integration"). Without `CONVEX_URL`
it runs standalone for development: each `LIBRARY_ROOTS` entry is scanned into memory and
playback events are logged. `CONVEX_URL` without the key refuses to start.

## HTTP

| Route                                                    | Purpose                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/playback/negotiate`                           | Token + client capabilities → mode, URL, subtitles                  |
| `POST /api/playback/seek`                                | Move an HLS stream; returns the generation and playlist URL to load |
| `POST /api/playback/stop`                                | End an HLS stream and delete its output (204)                       |
| `POST /api/playback/diagnostics`                         | A player's events with its token (204; 429 past the session budget) |
| `GET /api/health`                                        | Status, active streams, hardware acceleration                       |
| `GET /api/client-config`                                 | The Convex URL apps sign in to (`CONVEX_PUBLIC_URL`)                |
| `GET, HEAD /media/direct/:fileId?token=`                 | Original file with single byte ranges                               |
| `GET /media/hls/:streamId/:generation/index.m3u8?token=` | VOD playlist of one generation                                      |
| `GET /media/hls/:streamId/:generation/init.mp4?token=`   | fMP4 init segment                                                   |
| `GET /media/hls/:streamId/:generation/:index.m4s?token=` | fMP4 media segment                                                  |
| `GET /media/subtitles/:fileId/:track.vtt?token=`         | WebVTT (`e<stream>` embedded, `x<file-name hash>` sidecar)          |
| `GET /artwork/:key?w=`                                   | Artwork by sealed key, original or resized (185–1280), no token     |
| `GET, HEAD /media/music/stream/:trackId?ticket=&p=`      | A song: original or a transcode profile; `&start=` or `&finished=1` |
| `GET /music/art/:hash?ticket=`                           | Music artwork by hash, to its shareable ticket                      |
| `POST /api/metadata/candidates`                          | `metadata.searchCandidates` command (bearer Convex token, `manage`) |
| `POST /api/migration/connect`                            | `migration.connect` command (bearer Convex token, `admin`)          |
| `POST /api/migration/dry-run`                            | `migration.dryRun` command (bearer Convex token, `admin`)           |
| `POST /api/migration/import`                             | `migration.import` command (bearer Convex token, `admin`)           |
| `POST /api/logs`                                         | Retained log as NDJSON, followed on request (bearer, `admin`)       |
| `POST /api/diagnostics/playback`                         | `diagnostics.playback` command (bearer, `read`; own sessions)       |
| `POST /api/diagnostics/sessions`                         | `diagnostics.sessions` command (bearer, `read`; own sessions)       |
| `GET /*`                                                 | Built web app from `WEB_DIST_DIR`, with SPA fallback                |

The playback API (`/api/playback/*`, `/api/health`, `/api/client-config`) is the Effect HttpApi in
`@media/contracts/media-api`, built from the schemas and tagged errors in
`@media/contracts/media-playback`. Its errors are JSON bodies encoded with their schema, such as
`{"_tag":"StreamGenerationGone","streamId":"…","generation":1,"currentGeneration":2}` (410).
Registry `media` commands answer `{ code, message }` like Convex.

## Configuration

Required: `MEDIA_BASE_URL`, `DATA_DIR` (`/data/movies/media` in the image), `TRANSCODE_DIR`.
Optional with defaults: `LIBRARY_ROOTS` (comma list of approved mounts; none approves nothing, so
every scan is refused), `PORT` (4300), `HOST` (all interfaces), `BACKUP_DIR` (`/data/backups`;
`/data/core/backups` in the image), `TMDB_API_KEY` (v3 key or v4 read token), `OMDB_API_KEY`
(IMDb, Rotten Tomatoes, and Metacritic scores; without it titles keep TMDB's), `WEB_DIST_DIR`,
`MAX_CONCURRENT_TRANSCODES` (3), `MAX_CONCURRENT_REMUXES` (10: HLS streams that copy the video),
`HARDWARE_ACCELERATION` (`auto` tries Quick Sync, then VA-API, then software; `qsv`, `vaapi`,
`none`), `QSV_DEVICE` and `VAAPI_DEVICE` (`/dev/dri/renderD128`), `STREAM_IDLE_SECONDS` (60: a
stream's encoder stops after this long with no requests and no playing progress; the stream stays,
and its next request restarts the encoder; with no playback session reports, as in standalone mode,
a stream closes once its encoder has been stopped and unused for ten times this),
`STREAM_BUFFER_AHEAD_SECONDS` (120: ffmpeg pauses this far ahead of the player),
`MIN_FREE_TRANSCODE_MB` (2048), `LIBRARY_RECONCILE_MINUTES` (360), `LIBRARY_WATCH` (`auto`: file
events on local disks, polling on NFS, SMB/CIFS, 9p and FUSE mounts; `events`; `poll`),
`LIBRARY_POLL_SECONDS` (60), `PROBE_TIMEOUT_SECONDS` (60: ffprobe probes, artwork resizes, and
other short tool runs), `FILE_SCAN_TIMEOUT_SECONDS` (900: keyframe scans and embedded subtitle
extraction, which read a whole file), `CACHE_MAX_MB` (2048: provider responses, keyframe indexes,
subtitles, artwork, and music's cached transcodes under `DATA_DIR`, pruned hourly, least recently
used first; music's artwork under `DATA_DIR/music/art`, and the transcodes still being written
under `DATA_DIR/music/transcoding`, are never pruned), `TRICKPLAY`
(`on` or `off`: scrub thumbnail jobs), `TRICKPLAY_INTERVAL_SECONDS` (10, from 1 to 600),
`TRICKPLAY_CONCURRENCY` (1: files given thumbnails at once, besides other jobs), `FFMPEG_PATH`,
`FFPROBE_PATH`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `BACKUP_RETENTION_DAYS` (14),
`LOG_LEVEL` (`info`; `trace`, `debug`, `warn`, `error`: the least severe level logged, on standard
output and in the retained log), `LOG_RETENTION_DAYS` (14) and `LOG_MAX_MB` (512, from 8 to
1048576: the size the retained log files under `DATA_DIR/logs`, which `media logs` and
`media diagnostics playback` read, never grow past together). The dev stack sets
`LIBRARY_ROOTS` to its own `library` folder unless `MEDIA_LIBRARY_ROOTS` says otherwise.

The connection to the core (`packages/platform`), which the image, the NixOS module, and
`scripts/dev-stack.sh up` set: `CONVEX_URL` (the core's Convex URL the service connects to,
`http://127.0.0.1:3210` in the image), `CONVEX_PUBLIC_URL` (the core's Convex URL browsers use,
`MEDIA_BASE_URL/convex` in the installs; `/api/client-config` reports it, and it narrows the web
app's content security policy), `MEDIA_SERVICE_API_KEY` (the key the core issued this server's
service principal with `core/auth/apiKeys:issueServiceKey`; the installs create the principal and
issue the key on their first start, then keep it in a root-only file under the core's
`secrets/`), `MEDIA_TICKET_KEYS` (the core deployment's ticket key ring, `<kid>:<key>` entries
separated by commas, read from the deployment with `convex env get`; the service admits the byte
tickets the core signs with it, ADR 0011), `CONVEX_SELF_HOSTED_ADMIN_KEY` (the core's admin key)
and `CONVEX_BACKEND_DIR` (the deployed `packages/platform` folder, whose Convex CLI exports and
imports the core for backups and restores).

QSV needs an ffmpeg built with libvpl; the Nix dev shell uses `ffmpeg-full` for that. ffmpeg and
ffprobe see `LIBVA_DRIVER_NAME`, `LIBVA_DRIVERS_PATH`, and `ONEVPL_SEARCH_PATH` when they are set.
The installs expose every setting: `deploy/compose/.env.example`, the NixOS module's options, and
the README's configuration table (`scripts/check-deploy.sh` keeps them in step).

Every response carries a content security policy (scripts from this origin only), `nosniff`,
`Referrer-Policy: no-referrer` (media URLs carry tokens), and `frame-ancestors 'none'`. Request
bodies must declare a `Content-Length` of at most 128 KiB. ffmpeg and ffprobe run with a minimal
environment, so a crafted file that exploits them finds no credentials.

`/artwork`, `/api/health`, and `/api/client-config` are rate limited per client. The client is the
direct peer, or, from a loopback peer, the last `X-Forwarded-For` entry, which the installs' Caddy
sets to the client it resolved through `MEDIA_TRUSTED_PROXIES`. A loopback caller without the
header, such as the container's health check, is not limited.

## Convex integration

`src/convex/` holds the Convex side; `src/main.ts` composes it.

- `MediaBackend` (`media-backend.ts`): the SDK's WebSocket transport and auth, signed in with
  `MEDIA_SERVICE_API_KEY` through the `apikey` provider, with every `mediaService:*` call typed by
  `@media/contracts/media-service`. Sign-in retries with capped exponential backoff, a session
  that ends (restore, revocation) signs in again, and dropped subscriptions resubscribe.
  `GET /api/health` reports `backend: connected | connecting | standalone`.
- `LibrarySink` over `upsertScanned`, `markMissing`, and `fileIndex` (`convex-library-sink.ts`),
  translating with `catalog-records.ts`: absolute paths, the full probe, sealed artwork keys, and
  match keys (`movie:tmdb:603`, `show:local:fixture show (2021)`). Extras are not stored.
- `FileResolver` over `resolveFile` (`convex-file-resolver.ts`): cached 30 s, the path must lie in
  the library's folders, and `resolveInsideRoots` re-checks the real path against `LIBRARY_ROOTS`.
- `PlaybackReporter` over `recordPlaybackMode`, written from a queue so negotiation never waits.
- `LibrarySync` follows `libraries`: the monitor watches and reconciles exactly those libraries.
- `EndedSessions` follows `sessionStatus` for each session whose token arrives, and an HLS stream
  follows its own session: an ended session's streams stop and its tokens are refused
  (`PlaybackSessionEnded`, 410). The first request of a session waits up to 5 s for Convex's answer,
  then is served while the answer is still awaited. Up to 16,384 ends are kept for a token's
  six-hour life, apart from the 4096 sessions followed at once; an expired token follows nothing.
- `JobWorker` (`src/jobs/`) claims `pendingJobs` it has a handler for with a 60 s lease renewed
  every 15 s (with progress), interrupts the handler when the job is cancelled or the lease is
  lost, and completes or fails the job (`retry` returns it to the queue). Handlers: `scan`
  (through the library monitor, so scans of one library never overlap; a folder outside
  `LIBRARY_ROOTS` fails the job for good), `metadata` (refresh and fix-match through TMDB), and
  `migration` (see "Migration").

Extension points in `src/main.ts`: `jobHandlers` (one handler per job kind) and `commandRoutes`
(route groups of registry `media` commands, built with `commandRoute` in
`src/http/command-routes.ts`, which authorizes the bearer token through `account.viewer`).

The tests use the in-memory `MemoryLibrary` (`LibrarySink` + `FileResolver`) and a recording
`PlaybackReporter`.

## Migration

`src/migration/` imports from Jellyfin and Plex (decisions in `docs/decisions.md`, "Migration from
Jellyfin and Plex").

- `source-plugin.ts`: the migration-source plugin contract (manifest, source-neutral records,
  typed `Source*` errors) and the request guard. `jellyfin.ts` and `plex.ts` implement it over
  `source-http.ts`; `sources.ts` picks one.
- `migrations.ts`: connect, dry run, and import for the routes in `migration-routes.ts`;
  connections live in memory for an hour.
- `paths.ts` (path mapping and normalization), `matching.ts` (path, then provider IDs), and
  `planner.ts` (the plan and the dry-run summary) are pure.
- `migration-job.ts`: the `migration` job handler, resuming from its Convex checkpoint;
  `migration-backend.ts` is its view of Convex; `credentials.ts` seals source credentials for the
  stored plan.

Tests replay recorded servers (`testing/recorded-server.ts`): `fixtures/jellyfin.json` was
recorded from a real Jellyfin with `node scripts/record-jellyfin-fixtures.ts` (Docker, the
`jellyfin/jellyfin:12.2` image pinned by digest in `jellyfin-docker.ts`, or `JELLYFIN_IMAGE`); `fixtures/plex.json` is written from Plex's
API documentation and needs checking against a real server.

## Tests against a real stack

```sh
scripts/dev-stack.sh up
pnpm --filter @media/server test:stack
```

Builds the service and the CLI, generates the fixture library, starts the service on the stack's
media port (stop a `pnpm dev` service first), and proves the slice: an admin adds libraries, the
scan jobs run, titles carry probe, NFO metadata, and artwork; direct play with byte ranges, HLS
remux, and software transcode; progress reaches continue watching; an ended session stops its
stream; metadata commands check scopes; the same through `media scan --wait`, `search`, `play`
(the URL is probed with ffprobe), `progress`, and `continue`; and a job whose worker died is
claimed again after its lease expires (up to a minute, the release cron's interval).

The migration suite connects to the recorded Jellyfin and Plex servers, dry-runs, imports, and
reads each profile's history, continue watching, My List, and collections back from Convex, then
imports again through `media import --wait` without duplicates. With `MEDIA_JELLYFIN_DOCKER=1`
and the pinned `jellyfin/jellyfin:12.2@sha256:…` image pulled (the reference in
`.github/workflows/ci.yml`; a bare `12.2` pull counts only while the tag still has that digest), it
also sets up a real Jellyfin in Docker over the
fixture library (about 15 seconds) and imports from it with a password sign-in. The suites run one
file at a time because each starts the service on the stack's media port.

## Effect unstable modules

Effect 4.0.3 marks its HTTP, platform, process, observability, and some core modules
`@stability unstable`, and the lint preset rejects unstable APIs. `tsconfig.json` allows exactly
the modules this service depends on (`allowedUnstableApis`): the architecture chose Effect
HttpApi and the lint rules require Effect's `FileSystem`. Tests drive processes through
`ChildProcessSpawner`; the service starts its own children through `platform/scoped-process.ts`,
which never signals a process id (ADR 0014).
`@media/contracts` allows only `effect/http-api`, for the HttpApi definition in `media-api.ts`;
the SDK uses none and decodes the same schemas from `media-playback.ts` over `fetch`.
