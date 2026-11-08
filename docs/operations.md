# Operations

Running a [movies] install: what the two installs do at startup, where state lives, backups and
restores, upgrades, hardware acceleration, and telemetry. The README has the quick start.

## What runs

| Piece           | Compose (`deploy/compose`)                                  | NixOS (`services.media`)                               |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Convex backends | the core's and old movies', in the image                    | `media-core-convex` and `movies-convex` OCI containers |
| Media service   | in the image, runs as `PUID:PGID`                           | native `movies.service`, user `movies`                 |
| Caddy, one port | in the image, port 8080                                     | `media-proxy.service` on `listenAddress:port`          |
| Web clients     | account client by Caddy, movies client by the media service | the same                                               |
| Core database   | `media-data` volume, `/data/core`                           | `dataDir/core` (`/var/lib/media/core`)                 |
| Movies database | `media-data` volume, `/data/movies/convex`                  | `dataDir/movies/convex`                                |
| Service state   | `media-data` volume, `/data/movies/media`                   | `dataDir/movies/media`                                 |
| Backups         | `media-data` volume, `/data/movies/backups`                 | `backupDir` (`dataDir/movies/backups`)                 |
| HLS segments    | `media-transcode` volume                                    | `transcodeDir` (`/var/cache/movies/...`)               |
| Libraries       | bind mounts under `/media`, read-only                       | `libraryDirs`, read-only to the service                |

Both Convex backends and the media service listen on loopback only. Caddy serves them on the one
port with the routes in `deploy/image/rootfs/etc/caddy/Caddyfile` (ADR 0026). Convex's HTTP actions
stay inside the install (ADR 0025).

Every start, as root, before the media service runs unprivileged (steps 1 to 4 run for the core,
then for old movies):

1. Derive the Convex admin key from the backend's instance secret. It is never written to disk
   except movies' key into the service's private environment under `/run/movies` (tmpfs).
2. If the release or the project's functions changed, export a backup first
   (`core-manual-<timestamp>.zip` in `/data/core/backups`, `movies-manual-<timestamp>.zip` in the
   movies backup folder).
3. Deploy the project's bundled Convex functions.
4. Configure the deployment. The core's (`packages/platform/scripts/configure.ts`) also runs its
   schema migrations. Movies' (`packages/backend/scripts/configure.ts`) sets Convex Auth's JWT
   keys, `SITE_URL` (the public URL plus `/movies`), `MEDIA_BASE_URL`, `PLAYBACK_TOKEN_SECRET`,
   and the media service's restricted key. Existing secrets are kept, so this is safe to repeat.
5. Write each public Convex URL into a copy of its web client: `MEDIA_BASE_URL/convex` for the
   account client, `MEDIA_BASE_URL/movies/convex` for the movies client.
6. Start the media service with its secrets in `/run/movies/media.env` (mode 0600, owned by the
   service user). No secret is in the image, the Nix store, a command line, or the web app.

## Backups

- A Convex cron requests a backup every night at 03:00 UTC. The media service runs it as a job:
  `convex export --include-file-storage` into a hidden partial file in the backup folder, renamed
  to `movies-nightly-<timestamp>.zip` only when the export succeeded.
- Archives are `0600` in a `0700` folder owned by the service user: they hold every account's
  password hash and the media service key's hash. Copy them off the machine with the same care.
- After a new backup succeeds, archives older than `BACKUP_RETENTION_DAYS` (14) are deleted. The
  new archive is never deleted, and nothing is pruned after a failed backup.
- Back up now: Admin → Backups in the web app, or `media backup --wait`.
- Deployment environment variables (JWT keys, playback secret, service key) are not part of an
  export. A restore keeps the current ones and the startup configuration fills in anything
  missing.

## Restore

Admin → Backups → Restore in the web app, or with the CLI as an admin:

```sh
media backups list
media restore movies-nightly-2026-10-12T03-00-00-000Z.zip
```

The media service (`POST /api/backups/restore`) then:

1. runs `convex import --replace-all` with the archive (only archives inside the backup folder),
2. registers its own key again (the snapshot may come from another deployment),
3. settles the jobs the snapshot caught mid-run (`maintenance:settleRestoredJobs`),
4. ends every session (`maintenance:endAllSessions`): everyone, including the admin who
   restored, signs in again; the media service signs back in by itself,
5. lists the archives on disk again, since the snapshot's backup list is older.

The restore replaces everything in Convex: accounts, profiles, libraries, history, and rooms.
Files on disk are not touched; the next library scan reconciles them.

### Restoring onto a new machine

1. Install [movies] (Compose or NixOS) and start it once.
2. Copy the archive into the backup folder
   (`docker compose cp backup.zip media:/data/movies/backups/` and
   `docker compose exec media chown movies:movies /data/movies/backups/backup.zip`, or into
   `backupDir` owned by `movies` on NixOS) and restart the media service, which lists it.
3. Create a temporary owner account in the movies client (the first account on an empty
   deployment is the owner), then restore the archive as above. The temporary account is replaced by the
   snapshot's accounts.
4. Mount the libraries at the same paths as before, or edit each library's folders afterwards.

### Restoring without the media service

If the media service cannot start, restore with the Convex CLI in the image:

```sh
docker compose exec media sh -c '
  export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3220
  export CONVEX_SELF_HOSTED_ADMIN_KEY="$(sed -n "s/^CONVEX_SELF_HOSTED_ADMIN_KEY=//p" /run/movies/media.env)"
  cd /app/backend
  node node_modules/convex/bin/main.js import --replace-all --yes /data/movies/backups/<archive>.zip
  node node_modules/convex/bin/main.js run maintenance:settleRestoredJobs
  node node_modules/convex/bin/main.js run maintenance:endAllSessions'
docker compose restart media    # configures again and re-registers the service key
```

On NixOS, run the same commands as root with `movies-convex` (from the package) in place of
`node node_modules/convex/bin/main.js`, `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3220`, the
admin key from `/run/movies/media.env`, then `systemctl restart movies`.

## Upgrading

Releases are git tags `vX.Y.Z`. Each one publishes the image as `X.Y.Z`, `X.Y`, and, unless a
higher version is already tagged, `latest` (pre-releases such as `v0.2.0-rc.1` only as
`0.2.0-rc.1`); `main` publishes `:main`, the edge,
and every build also gets `sha-<commit>`. The NixOS module follows whatever revision the flake
input points at. A release also publishes the `media` CLI at the same version: `@lmdevv/movies` on
npm and standalone binaries on the tag's GitHub Release. Upgrade a CLI installed that way with
`npm install -g @lmdevv/movies@X.Y.Z` or the release's binary, fetched with `curl` as in the
[README](../README.md#cli) (macOS quarantines a browser download, and Gatekeeper then blocks the
ad hoc signed binary until `xattr -d com.apple.quarantine`); the image and the Nix modules carry
their own.

| Track     | Compose `MEDIA_IMAGE`                              | NixOS flake input            |
| --------- | -------------------------------------------------- | ---------------------------- |
| A release | `ghcr.io/lmdevv/media:latest`, `:0.2`, or `:0.2.1` | `github:lmdevv/media/v0.2.1` |
| Edge      | `ghcr.io/lmdevv/media:main`                        | `github:lmdevv/media`        |

### Compose

Keep the checkout and `MEDIA_IMAGE` on the same release, since `compose.yaml` passes the settings
and volumes that release's image expects. The image carries both Convex backends itself. `:latest`
follows the newest release whatever the checkout, so pin the version when you check out a tag.

```sh
cd media && git fetch --tags && git checkout v0.2.0      # or `git pull` on main for the edge
cd deploy/compose
# .env: MEDIA_IMAGE=ghcr.io/lmdevv/media:0.2.0             # or :main for the edge
docker compose pull
docker compose up -d
docker compose logs -f media     # "upgrading movies from 0.1.0 to 0.2.0; backing up to ... first"
```

### NixOS

```sh
nix flake update movies          # or point the input at the new tag
nixos-rebuild switch
journalctl -u movies -f
```

### What an upgrade does

The first start of a new version exports a backup of each project, `core-manual-<timestamp>.zip`
and `movies-manual-<timestamp>.zip`, before it deploys the new functions. A new version is a new
release or any build whose Convex functions differ: the image and the Nix package record a hash of
each project's functions, so following `main` or building locally backs up too. Convex refuses to
deploy a schema the stored documents do not match, so such a deploy fails and the start stops with
the old functions still in place; restarts after that do not export again for the same version.
Convex backend upgrades ride along with [movies] releases; never change its image on your own.

### Rolling back

1. Go back to the previous version: `git checkout v0.1.0` and its image tag
   (`MEDIA_IMAGE=ghcr.io/lmdevv/media:0.1.0`, then `docker compose up -d`), or
   `nixos-rebuild switch --rollback`.
2. If the older functions start, restore the `movies-manual-…` archive the upgrade took (Admin →
   Backups, or `media restore`). If they do not deploy over the newer data, restore without the
   media service (above) and start it again.

### Releasing

For maintainers. One version covers the image, the Nix packages, `@lmdevv/movies` on npm, and the
CLI binaries. `scripts/check-version.sh`, run by CI and the pre-commit hook, fails while any
workspace package carries another version. The iOS app's store version (`expo.version` in
`apps/mobile/app.json`) is not part of it: the App Store build ships through review on its own
schedule, so a server release does not bump it.

1. On `main`, set every package's version, then commit and merge it:

   ```sh
   pnpm -r exec npm pkg set version=0.2.0
   scripts/check-version.sh     # 0.2.0
   ```

2. Tag the merged commit and push the tag:

   ```sh
   git tag -a v0.2.0 -m "[movies] 0.2.0" && git push origin v0.2.0
   ```

The tag runs two workflows, and each refuses a tag that does not name the package version:

- `image.yml` runs the packaged-stack smoke test and publishes the multi-arch image.
- `release.yml` builds the standalone binaries on their own runners (`linux-x64`, `linux-arm64`,
  and `darwin-arm64`, signed ad hoc, from a pinned Node version) and checks each one's
  `--version`. It then waits for the tag's `image.yml` run. Only once that run has published the
  image does it publish `@lmdevv/movies` to npm through trusted publishing, with a provenance
  attestation, and create the GitHub Release with the binaries, `SHA256SUMS`, the third-party
  licenses (Node.js's among them), install notes, and generated notes.

If the image fails, nothing reaches npm or the Release: fix the cause, rerun `image.yml`, then
rerun `release.yml`. Every job can run again: npm skips a version it already has, and the release
replaces its assets and publishes a release an earlier run left as a draft.

`scripts/release-channel.sh` decides what a version becomes. The highest stable version among the
`v*` tags is npm's `latest` and the latest GitHub Release. A backport to an older line, such as
`v0.2.5` after `v0.3.0`, publishes under the npm dist-tag `release-0.2` and is not marked latest.
A pre-release such as `v0.3.0-rc.1` publishes under `next` and makes a GitHub pre-release.

npm only lets a trusted publisher be set on a package that exists, so the first version is
published by hand, before its tag is pushed. Run it from an npm account in the `lmdevv` org:

```sh
npm login
mkdir -p /tmp/movies-cli && pnpm --filter @lmdevv/movies pack --pack-destination /tmp/movies-cli
npm publish /tmp/movies-cli/lmdevv-movies-0.2.0.tgz --access public
```

Then, on npmjs.com, open `@lmdevv/movies` → Settings → Trusted publishing, choose GitHub Actions,
and enter the owner `lmdevv`, the repository `media`, and the workflow `release.yml`. Once a tag
has published through it, set Publishing access to require two-factor authentication and
disallow tokens.

## Remote access

The port listens on `127.0.0.1` by default. For use away from home, put the host on a Tailscale
tailnet and set the bind address (`MEDIA_BIND` on Compose, `listenAddress` on NixOS) to the
host's Tailscale address, or keep localhost and use `tailscale serve`. Do not expose the port to
the internet. It speaks plain HTTP, and every browser and CLI that uses [movies] must reach it.

## Hardware acceleration

The media service uses Intel Quick Sync (QSV) through ffmpeg's libvpl when it can, then VA-API
(Intel and AMD), and falls back to software encoding when a GPU run fails.

- Compose: add `-f compose.qsv.yaml` (or `-f compose.vaapi.yaml` for VA-API) to pass `/dev/dri`
  through. The image carries Debian's ffmpeg 7.1 (built with libvpl), Intel's iHD VA-API driver,
  the oneVPL GPU runtime, and Mesa's VA-API drivers (amd64). Quick Sync covers Gen12 and newer
  iGPUs (Tiger Lake onwards) and Arc cards; older Intel iGPUs and AMD GPUs encode through VA-API.
- NixOS: `hardwareAcceleration = "qsv"` enables `hardware.graphics` with `intel-media-driver` and
  `vpl-gpu-rt`, gives the service the DRM render nodes and the `render` and `video` groups, and
  uses `ffmpeg-full` (the default nixpkgs `ffmpeg` has no libvpl). `"auto"` grants the devices and
  probes them without changing the host's graphics configuration. `"vaapi"` does the same for
  VA-API, with `vaapiDevice` for the render node.
- Verified on an Arc A380 in both installs (`QSV=1 scripts/stack-e2e.sh`,
  `HARDWARE_ACCELERATION=auto scripts/nixos-module-e2e.sh`).

## Telemetry and logs

- Logs are one JSON object per line on standard output (`docker compose logs media`,
  `journalctl -u movies`). The media service keeps the same lines, already redacted, in rotating
  NDJSON files under its data folder (`/data/movies/media/logs` in the Compose volume,
  `/var/lib/media/movies/media/logs` on NixOS, private to the service): a new file each day and at
  each start. Each name carries a sequence number and the time of the file's first record
  (`media-000000000042-20261021T140503123Z.ndjson`), so `ls` lists the files in the order they
  were written, and reading and retention follow that order even when the clock steps back. The
  files together never grow past `LOG_MAX_MB` (512, at least 8): each holds at most an eighth of
  it (64 MiB at most), and the oldest is deleted before a write would pass the cap. Files last
  written more than `LOG_RETENTION_DAYS` (14) ago go too. `LOG_LEVEL` (`info`) sets the least
  severe level for both; at `warn` or `error` the retained log loses the `INFO` records playback
  diagnostics read (stream starts, player attaches, startups and stalls), and the timeline says
  so. Lines waiting to be written are capped at 8 MiB of text; past that they are dropped and
  counted (`RetainedLogs.dropped`). When the folder cannot be written or read, the service logs
  to standard output only, says so once (`RetainedLogs.unwritable`), retries with every batch,
  and `media logs` says since when. A folder that comes back, such as a late mount, is listed
  again at once, so the files already in it count against the cap.
- Each HTTP response logs `HttpServer.response` at `DEBUG` with its method, status, time taken,
  and path (no query string, cut to 128 characters), so at the default `info` nothing a caller
  sends without a token reaches the retained log. A handler that died logs
  `HttpServer.handler_died` at `ERROR` with its cause. Every request gets a fresh UUID: each line
  logged while serving it carries it as `requestId`, and every response, a failed one too, sends
  it back in `x-request-id`. A caller's own `x-request-id` never replaces it; when it is 1 to 64
  letters, digits, `_`, or `-`, not shaped like a credential, and not a UUID that could pass for
  the service's own id, the lines carry it as `clientRequestId`. A stop ends open responses after 3 s, such as a direct-play file, which the
  player resumes with a range request; Compose gives the container 30 s to stop.
- `media logs` reads the retained log without SSH or `sudo`: `--follow`, `--since 15m` or a time,
  `--until`, `--level warn`, `--session-id`, `--stream-id`, `--slow 1s`, `--grep`, and `--json` for
  NDJSON. It needs an admin session. The service streams it as NDJSON from `POST /api/logs` and
  answers at most 5000 records before following. A follow ends as the service shuts down, and
  `media logs --follow` then exits `unavailable`.
- A failed media request (any 4xx or 5xx on `/media/`) logs `MediaRoutes.request_failed` at `WARN`
  with its playback session, at most 30 at once and one every 2 s per session (60, then one a
  second, per account), with path parameters cut to 64 characters. A token that is signed but
  expired or for another purpose still files its failure under its session, with the reason in
  `error`, such as `Playback token has expired`. Those refusals count against an account budget
  of their own, so replaying an old token cannot silence the account's real failures. The rest, and failures whose token is malformed,
  forged, or for another audience, log at `DEBUG`; every 30 s
  `MediaRoutes.request_failures_suppressed` counts the ones each session went over. A request
  after its session ended answers `410` and logs `MediaRoutes.request_after_session_ended` at
  `DEBUG` under its session, outside the budget and not counted as a failed request.
  Every HLS segment logs how long it took, split into waiting for the encoder, reading the disk,
  and writing to the network: `MediaRoutes.slow_segment` at `WARN` from one second,
  `MediaRoutes.segment` at `DEBUG` below. Stream starts, encoder restarts, mode changes, and ends
  (with the reason, such as `idle`) log at `INFO`.
- The web and iOS players report how long each session took to start, their stalls, errors,
  dropped frames (web only), hls.js segment load times, and recoveries to
  `POST /api/playback/diagnostics` with their playback token, in batches the service validates and
  limits: each session 300 events at once, then 2 a second; each account 400 at once, then 8 a
  second, so four screens of one family account can each report every hls.js segment load. A
  refused batch, and a refused diagnostics read, answers `429` with `Retry-After`. They land in the same log as `Player.*` records. An event's
  stream counts as its `streamId` only when the stream is the token's session's own (or ended in
  the last ten minutes); otherwise it is kept as `claimedStreamId`, which `--stream-id` does not
  match. `media diagnostics playback <session-id>` builds a session's timeline from both sides;
  admins read any session and other accounts only their own, a few times a minute. Audio/video drift is not measured:
  no player reports it.
- The web and iOS apps report their unexpected errors, a crashed page or screen and (web only)
  uncaught errors and unhandled rejections, to `POST /api/client-errors` with the signed-in
  account's token. Each lands as `Client.error` at `WARN` with the account, platform, app
  version, page, error name, message, and stack, cut to fixed bounds and redacted like every
  other line. The SDK request id an error carries is kept as `failedRequestId`, and a playback
  session the app names as `claimedSessionId`, never as `sessionId`, and `media diagnostics
  sessions` counts only records that name a session, so error reports never crowd sessions out.
  An app sends a repeated error once per 30 s and, after a `429`, nothing until its
  `Retry-After` has passed. The service takes 120 requests at once, then 2 a second, before it
  asks Convex who is calling; then each account 20 reports at once, then one every 10 s, and
  every account together 50 at once, then one every 5 s (about 95 MB a day at the largest
  reports). The rest answer `429` with `Retry-After`, and every 30 s
  `ClientErrors.suppressed` counts them by account (`userId` null for requests refused before
  the account was known). `media logs --grep Client.error` lists the reports.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` (Compose) or `otlpEndpoint` (NixOS) set to an OTLP/HTTP
  collector, the media service exports traces and logs: library scans, playback negotiation, the
  first HLS segment, seeks, encoder failures and GPU-to-software fallbacks, backups and restores, and
  migrations. `docker compose --profile telemetry up -d` starts a local collector that prints
  them (`deploy/compose/otel-collector.yaml`).
- Every log line and export is redacted on the way out: fields named like credentials and values
  shaped like tokens, API keys, Convex admin keys, credential query parameters, and invite codes.
  An invite code is redacted (`/invite/<redacted>`) in any case and after repeated slashes, in
  URL fields such as `http.url`, `url.full`, and `url.query`, in their query parameters such as
  `?redirect=%2Finvite%2F…`, and in absolute URLs and request lines (`GET /invite/…`) in
  messages. Playback URLs carry tokens, so automatic HTTP spans for `/media/` are off as well,
  and so are spans for paths that start with `//`, which a span would read as a host. With OTLP
  on, the console and the retained log keep the same redacted lines.
- [movies] sends nothing anywhere else: no analytics, no update checks. Both Convex backends run
  with their beacon disabled.

## Verifying an install

- `scripts/stack-e2e.sh` builds the image and runs the packaged suite against a fresh Compose
  stack: privilege and secret checks, owner sign-up, library, scan, direct and HLS playback, a
  media restart (streams answer a typed `StreamNotFound`, then play again), CLI backup and
  restore, the image's own `media` signing in to its stack, and an upgrade backup. CI runs it on
  every image change.
- `scripts/nixos-module-e2e.sh` does the same against the NixOS module's own unit on a NixOS host
  (needs sudo and Docker), and checks the sandbox.
- `scripts/check-sandbox.sh` runs the media tests (encoders started, released, and restarted
  with real ffmpeg, library scans, backups, downloads) under the module's system call filter, on
  the module's own Node and ffmpeg, with any denied call killing the process. The module returns
  `EPERM` for a denied call instead, so one in a dependency fails that call rather than ending
  every stream; the check keeps the service from relying on that. CI runs it on every change.
- `nix flake check` evaluates the server, CLI, and Home Manager modules and builds the packages.
