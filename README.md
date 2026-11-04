# [movies]

Self-hosted movies and TV for people and agents. Stream your own folders or NAS from one install,
with profiles, Netflix-style browsing, watching together at the same second, migration from
Jellyfin and Plex, and a CLI that can do everything the app can.

Early development: the MVP (media service, web app, SDK, CLI) is in place; native apps come later.

## Stack

- Convex (self-hosted) for product state, auth, and live sync
- A Node + Effect HttpApi media service for scanning, direct play, HLS remux, and Intel QSV
  transcoding with ffmpeg; it also serves the web app
- A Vite + React + TanStack Router web app
- An Effect SDK and CLI with an agent skill
- Docker Compose or a NixOS module

## Install

[docs/homelab.md](docs/homelab.md) walks through a homelab install end to end: Compose or NixOS,
Tailscale and a Caddy reverse proxy, GPU passthrough, where data lives, backups, and upgrading.

### Docker Compose

```sh
git clone https://github.com/lmdevv/media && cd media
git checkout "$(git describe --tags --abbrev=0 --exclude '*-*')"   # latest stable release, = :latest
cd deploy/compose
cp .env.example .env    # set MEDIA_LIBRARY, the two public URLs, and PUID/PGID
docker compose up -d
```

Open `MEDIA_BASE_URL` (default `http://localhost:8080`), create the owner account (the first
account is the owner), and add `/media/library` (or a folder in it) as a library.

- The `media` image (`ghcr.io/lmdevv/media`, amd64 and arm64) holds the media service, the web
  app, the Convex CLI with the bundled functions, the `media` CLI, and ffmpeg. Compose runs
  `:latest`, the newest release; pin `:X.Y` or `:X.Y.Z`, or follow `:main` for the edge.
  `docker compose build` builds it from source instead.
- Each start deploys the functions and configures the deployment; secrets are generated inside
  Convex, never written to `.env`.
- The media service runs as `PUID:PGID`, which must be able to read the library. Libraries mount
  read-only; add one line per folder under `volumes:` in `compose.yaml`.
- Intel Quick Sync: `docker compose -f compose.yaml -f compose.qsv.yaml up -d`; VA-API on Intel or
  AMD GPUs: `-f compose.vaapi.yaml` instead (GPU setup in
  [docs/homelab.md](docs/homelab.md#gpu-transcoding)).
- Upgrade with the checkout at the new release tag, then `docker compose pull && docker compose
  up -d`; each upgrade backs up first ([docs/operations.md](docs/operations.md#upgrading)).
- A local OpenTelemetry collector: `docker compose --profile telemetry up -d` with
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`.

### NixOS

```nix
# flake.nix
inputs.movies.url = "github:lmdevv/media";

# configuration.nix, with inputs.movies.nixosModules.default in modules
services.media = {
  enable = true;
  libraryDirs = [ "/srv/media/movies" "/srv/media/shows" ];
  listenAddress = "100.64.0.1";                       # the host's Tailscale address
  publicUrl = "http://nas.tailnet.ts.net:8080";
  convexPublicUrl = "http://nas.tailnet.ts.net:3210";
  hardwareAcceleration = "qsv";                       # Intel Gen12+ iGPU or Arc
  environmentFile = "/run/secrets/movies.env";        # TMDB_API_KEY=...; agenix or sops-nix
};
```

The Convex backend runs as a pinned OCI container; the media service runs natively as a sandboxed
systemd service built from this repository (`nix build github:lmdevv/media#movies`). Library
folders are read-only to it, and `openFirewall` is off by default.

## Configuration

Compose reads these names from `deploy/compose/.env` (see `.env.example`); empty means the
default. The NixOS options are in brackets.

| Name                          | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `MEDIA_LIBRARY`               | Host folder mounted read-only at `/media/library` (`libraryDirs`)         |
| `MEDIA_BASE_URL`              | URL of the web app and streams (`publicUrl`)                              |
| `CONVEX_PUBLIC_URL`           | URL browsers and the CLI use for Convex (`convexPublicUrl`)               |
| `MEDIA_BIND`                  | Address both ports listen on, `127.0.0.1` by default (`listenAddress`)    |
| `MEDIA_PORT`, `CONVEX_PORT`   | Ports, 8080 and 3210 (`port`, `convexPort`)                               |
| `PUID`, `PGID`                | User and group of the media service, 1000 (`user`, `group`)               |
| `MEDIA_IMAGE`, `TZ`           | Image to run, `ghcr.io/lmdevv/media:latest`; time zone, UTC               |
| `TMDB_API_KEY`                | TMDB key or read token for metadata and artwork (`tmdbApiKeyFile`)        |
| `OMDB_API_KEY`                | OMDb key for IMDb, RT, and Metacritic scores (`omdbApiKeyFile`)           |
| `LIBRARY_ROOTS`               | Approved library folders in the container, `/media` (from `libraryDirs`)  |
| `HARDWARE_ACCELERATION`       | `auto`, `qsv`, `vaapi`, or `none`, `auto` (`hardwareAcceleration`)        |
| `QSV_DEVICE`                  | Render node for Quick Sync, `/dev/dri/renderD128` (`qsvDevice`)           |
| `VAAPI_DEVICE`                | Render node for VA-API, `/dev/dri/renderD128` (`vaapiDevice`)             |
| `LIBVA_DRIVER_NAME`           | VA-API driver, such as `iHD`; detected when empty (`extraEnvironment`)    |
| `MAX_CONCURRENT_TRANSCODES`   | Simultaneous transcodes, 3 (`maxConcurrentTranscodes`)                    |
| `MAX_CONCURRENT_REMUXES`      | Simultaneous remux and audio-only streams, 10 (`maxConcurrentRemuxes`)    |
| `STREAM_IDLE_SECONDS`         | A quiet stream's encoder stops after this, 60 (`streamIdleSeconds`)       |
| `STREAM_BUFFER_AHEAD_SECONDS` | How far ffmpeg runs ahead of the player, 120 (`streamBufferAheadSeconds`) |
| `MIN_FREE_TRANSCODE_MB`       | Free space the transcode folder keeps, 2048 MiB (`minFreeTranscodeMb`)    |
| `LIBRARY_RECONCILE_MINUTES`   | Full library reconciliation interval, 360 (`libraryReconcileMinutes`)     |
| `TRICKPLAY`                   | Scrub thumbnails, `on` or `off`, `on` (`trickplay.enable`)                |
| `TRICKPLAY_INTERVAL_SECONDS`  | Seconds between scrub thumbnails, 10 (`trickplay.intervalSeconds`)        |
| `TRICKPLAY_CONCURRENCY`       | Files given thumbnails at once, 1 (`trickplay.concurrency`)               |
| `LIBRARY_WATCH`               | `auto`, `events`, or `poll`; `auto` polls network shares (`libraryWatch`) |
| `LIBRARY_POLL_SECONDS`        | Seconds between polls of a share, 60 (`libraryPollSeconds`)               |
| `PROBE_TIMEOUT_SECONDS`       | Longest probe or artwork resize, 60 (`probeTimeoutSeconds`)               |
| `FILE_SCAN_TIMEOUT_SECONDS`   | Longest whole-file scan, 900 (`fileScanTimeoutSeconds`)                   |
| `CACHE_MAX_MB`                | Size the caches are pruned to, 2048 MiB (`cacheMaxMb`)                    |
| `BACKUP_RETENTION_DAYS`       | Days of nightly backups kept, 14 (`backupRetentionDays`)                  |
| `LOG_LEVEL`                   | Least severe level logged and retained, `info` (`logLevel`)               |
| `LOG_RETENTION_DAYS`          | Days the retained logs are kept, 14 (`logRetentionDays`)                  |
| `LOG_MAX_MB`                  | Size the retained logs never pass, 512 MiB, at least 8 (`logMaxMb`)       |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional OTLP/HTTP collector for traces and logs (`otlpEndpoint`)         |

On NixOS, `environmentFile` adds secrets (such as `TMDB_API_KEY`) from a root-only file and
`extraEnvironment` sets anything else. The media service's own settings are listed in
`apps/media/README.md`.

## Demo library

No films of your own yet, or want to see every feature at once? Build a library of free Creative
Commons films and shows:

```sh
scripts/demo-library.sh --dir ~/movies-demo                 # about 3 GB
scripts/demo-library.sh --dir ~/movies-demo --set minimal   # about 0.6 GB
scripts/demo-library.sh --dir ~/movies-demo --set full      # about 6 GB, adds Pioneer One
```

It needs `curl`, `ffmpeg`, and `unzip`, plus `spumux` from dvdauthor for the image subtitle
(`nix develop` has all of them). Add `~/movies-demo/Movies` as a movies library and
`~/movies-demo/Shows` as a shows library (with Compose, point `MEDIA_LIBRARY` at
`~/movies-demo`).

- **Movies:** Big Buck Bunny, Elephants Dream, Sintel, Tears of Steel (with subtitles in 20
  languages), and Cosmos Laundromat. **Shows:** Caminandes (VP8 and Vorbis in Ogg, so it is always
  transcoded) and, in the full set, the six episodes of Pioneer One.
- **[movies] Feature Test:** the first five minutes of Sintel in four versions of one title:
  direct play with chapters and sidecar subtitles, HDR10 HEVC for tone mapping, AC3 5.1 plus
  stereo with ten text subtitles and an image (VobSub) subtitle, and an interlaced PAL MPEG-2
  "DVD rip".
- Every title has a Kodi-style NFO with IMDb and TMDB IDs, cast and crew, genres, and studios,
  so it matches without a TMDB key, and local posters and backgrounds taken from the film.
  Credits and licenses are written to `CREDITS.md` in the library folder.

The full set also ships, with five Creative Commons albums under `Music`, as a data-only image,
`ghcr.io/lmdevv/media-demo-library:v1`, so a Compose install can mount it with no download script:
`docker compose -f compose.yaml -f compose.demo.yaml up -d` in `deploy/compose`, then add
`/media/library/Movies` and `/media/library/Shows`. [docs/demo-library.md](docs/demo-library.md)
covers what it holds, building it, and its credits.

## Remote access

Keep both ports off the internet. For use away from home, join the host to a Tailscale tailnet and
bind to its Tailscale address (`MEDIA_BIND` / `listenAddress`), or keep the localhost default and
use `tailscale serve`. Convex and the media service speak plain HTTP, and every browser and CLI
must reach both ports.

## Backups and restore

Every night at 03:00 UTC the media service exports the whole database, file storage included, to
the backup folder (`/data/backups` in the `movies-data` volume, or `backupDir` on NixOS) and keeps
14 days. Each upgrade also backs up before it deploys. Restore from Admin → Backups, or:

```sh
media backup --wait
media backups list
media restore movies-nightly-2026-10-12T03-00-00-000Z.zip   # everyone signs in again
```

Archives hold password hashes; store copies as carefully as the server. See
[docs/operations.md](docs/operations.md) for restoring onto a new machine or without the media
service.

## CLI

`media` runs everything the app can, for people and agents. Each release ships it with the same
version as the server.

| Where                       | Install                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| The Compose server          | In the image: `docker compose exec movies media login`                                         |
| The NixOS server            | Installed by `services.media`, pointed at the server                                           |
| Anywhere with Node 22+      | `npm install -g @lmdevv/movies`                                                                |
| Linux or macOS without Node | `media-<os>-<arch>` from the [latest release](https://github.com/lmdevv/media/releases/latest) |
| Another NixOS machine       | `nixosModules.cli` with `programs.media` (below)                                               |
| Home Manager (Linux, macOS) | `homeManagerModules.movies` with `programs.media` (below)                                      |
| Nix, once                   | `nix run github:lmdevv/media -- --help`                                                        |

```sh
media login --server http://nas.tailnet.ts.net:3210 --media-url http://nas.tailnet.ts.net:8080
media search alien
media play "Alien" --open        # mpv; without --open, prints the stream URL
media libraries list --human
```

The release binaries cover Linux on x64 and arm64 and macOS on Apple silicon. Download one with
`curl`, check it, and put it on your `PATH` (`media-darwin-arm64` and `shasum -a 256 -c` on a
Mac):

```sh
curl -fLO https://github.com/lmdevv/media/releases/latest/download/media-linux-x64
curl -fLO https://github.com/lmdevv/media/releases/latest/download/SHA256SUMS
grep media-linux-x64 SHA256SUMS | sha256sum -c
mkdir -p ~/.local/bin && install -m 755 media-linux-x64 ~/.local/bin/media
```

The macOS binary is signed ad hoc, not notarized. macOS quarantines a file downloaded in a
browser, and Gatekeeper then refuses to run it; `curl` does not quarantine, or clear it with
`xattr -d com.apple.quarantine media-darwin-arm64`.

`MEDIA_SERVER_URL` (or `login --media-url`) is where the CLI reaches the media service, for its
`media` commands and for playback. The stream URL `media play` prints is always the server's
public one (`MEDIA_BASE_URL`), so a player on another machine can open it.

In the Compose image, `MEDIA_CONVEX_URL` and `MEDIA_SERVER_URL` point at that stack from inside
the container. `docker compose exec movies media` runs as root, so its login in the `movies-data`
volume (`/data/config`) is readable by root only, and stays across upgrades. On NixOS,
`services.media` sets both variables for every user, so `media login` needs no `--server`;
`programs.media.enable = false` leaves the CLI out. Another NixOS machine, or Home Manager on
Linux or macOS, sets the two URLs itself:

```nix
# NixOS: inputs.movies.nixosModules.cli in the system's modules.
# Home Manager: inputs.movies.homeManagerModules.movies in home-manager's modules.
programs.media = {
  enable = true;
  convexUrl = "http://nas.tailnet.ts.net:3210";
  mediaUrl = "http://nas.tailnet.ts.net:8080";
  # It builds with your nixpkgs; on an older one, use the flake's own build:
  # package = inputs.movies.packages.${pkgs.stdenv.hostPlatform.system}.cli;
};
```

The variables win over a login's stored server: while `MEDIA_CONVEX_URL` names another server, a
profile saved for a different one stays unused, whatever `--profile` says. To use that profile,
clear both for the command: `MEDIA_CONVEX_URL= MEDIA_SERVER_URL= media whoami`. The NixOS
modules set them for every user on the machine. Home Manager sets them in `home.sessionVariables`,
which only shells Home Manager configures load: on macOS, enable `programs.zsh` (or your shell) in
Home Manager, or pass `--server` and `--media-url` to `media login` instead.

No install stores a credential: each user runs `media login` once, or sets `MEDIA_API_KEY`.
Output is JSON by default. Agents get an API key from Settings → API keys and follow
[apps/cli/skills/media/SKILL.md](apps/cli/skills/media/SKILL.md), which loads one reference per
domain. In a checkout, `pnpm --filter @lmdevv/movies build` writes `apps/cli/dist/media.js`.

`media --help` lists the `auth`, `admin`, `movies`, and `music` groups first. Until the movies
port, the movies commands stay at the top level against the movies server, and the `auth` and
`admin` groups reach the new core server with their own sign-in (`media auth login`).
`media admin reset-password [<username>]` sets a new password from the server host with the
core's admin key (`--env-file`, or `MEDIA_CORE_URL` and `MEDIA_CORE_ADMIN_KEY`).

## iOS app

`apps/mobile` is the iPhone app: Expo, Expo Router, and Uniwind over the same SDK. People type the
server's address; the app asks the media service where accounts live and signs in from there.
Building and running it is in [apps/mobile/README.md](apps/mobile/README.md).

## Telemetry

No analytics and no phoning home. Logs are JSON lines with tokens, keys, and passwords redacted;
traces and logs go to your own OTLP collector only when you set one. Details in
[docs/operations.md](docs/operations.md).

## Development

```sh
nix develop                  # Node 24, pnpm, ffmpeg-full
pnpm install
scripts/dev-stack.sh up      # a Convex backend for this worktree
pnpm dev                     # web on :3001 and Convex dev
pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test
scripts/stack-e2e.sh         # build the image and test the packaged install
nix flake check              # build the Nix package and evaluate the NixOS module
```

See `AGENTS.md` for the layout, rules, and checks, and `docs/` for decisions and operations.

## License

[movies] is MIT-licensed. The self-hosted Convex backend it runs (`ghcr.io/convex/convex-backend`)
is FSL-1.1-Apache-2.0: each release converts to Apache-2.0 two years after it ships. The image
includes Debian's ffmpeg (LGPL/GPL) and the non-free build of Intel's media driver, whose
encoding kernels are proprietary; the NixOS module uses nixpkgs `ffmpeg-full`.
