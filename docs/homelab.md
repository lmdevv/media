# Homelab install

[movies] on one box at home, with Docker Compose or NixOS, in about ten minutes. It runs two
things: the self-hosted Convex backend (port 3210) and the media service, which also serves the
web app (port 8080). Browsers and the CLI talk to both. `docs/operations.md` explains what happens
at startup, backups and restores, and telemetry in more depth.

## Before you start

- A Linux host with your library on a local disk or a NAS mount. The library is mounted
  read-only; [movies] never writes to it.
- 2 GB of RAM for the two services, plus a few GB of fast disk for transcoding.
- Decide how people reach it: only this machine (the default), your tailnet (recommended, below),
  or a reverse proxy with TLS on your LAN. Never put either port on the internet.

## Docker Compose

```sh
git clone https://github.com/lmdevv/media && cd media
git checkout "$(git describe --tags --abbrev=0 --exclude '*-*')"   # latest stable release, = :latest
cd deploy/compose
cp .env.example .env
```

Edit `.env`:

```sh
MEDIA_LIBRARY=/srv/media                 # host folder with your movies and shows
MEDIA_BASE_URL=http://nas.tailnet.ts.net:8080
CONVEX_PUBLIC_URL=http://nas.tailnet.ts.net:3210
MEDIA_BIND=100.64.0.1                    # the host's Tailscale address (`tailscale ip -4`)
PUID=1000                                 # a user that can read MEDIA_LIBRARY (`id -u you`)
PGID=1000
TMDB_API_KEY=...                          # optional: posters and metadata from TMDB
```

Then start it and watch it come up (the first start deploys the database functions, about a
minute):

```sh
docker compose up -d
docker compose ps          # movies turns (healthy)
docker compose logs -f movies
```

Open `MEDIA_BASE_URL`, create the owner account (the first account is the owner), and add
`/media/library` as a library. More folders: add one read-only line per folder under the `movies`
service's `volumes:` (`- /mnt/nas/shows:/media/shows:ro`) and add `/media/shows` as a library.

- **Image.** `MEDIA_IMAGE` defaults to `ghcr.io/lmdevv/media:latest`, the newest release. Best
  is the release your checkout is at (`git checkout vX.Y.Z` with `:X.Y.Z`), or `main` with
  `:main` to follow development, since `compose.yaml` pins the Convex backend for its release.
  `docker compose build` builds the image from your checkout instead. Images exist for amd64 and
  arm64; Quick Sync drivers are amd64 only.
- **Settings.** Every name in `.env.example`, explained in the README's configuration table. The
  install sets the rest (paths, ports, Convex credentials) itself.
- **Privileges.** The entrypoint runs as root only to set up, then runs the media service as
  `PUID:PGID` with no capabilities. `init: true` reaps ffmpeg processes.

## NixOS

```nix
# flake.nix
inputs.movies.url = "github:lmdevv/media";   # or github:lmdevv/media/v0.1.0 to pin a release

# in nixosSystem { modules = [ ... ]; }
inputs.movies.nixosModules.default
{
  services.media = {
    enable = true;
    libraryDirs = [ "/srv/media/movies" "/srv/media/shows" ];
    listenAddress = "100.64.0.1";                     # the host's Tailscale address
    publicUrl = "http://nas.tailnet.ts.net:8080";
    convexPublicUrl = "http://nas.tailnet.ts.net:3210";
    hardwareAcceleration = "qsv";                     # see GPU below; "auto" by default
    environmentFile = "/run/secrets/movies.env";      # TMDB_API_KEY=..., from agenix or sops-nix
  };
}
```

`nixos-rebuild switch`, then `systemctl status movies` and `journalctl -u movies -f`. The Convex
backend runs as the `movies-convex` OCI container (Podman unless
`virtualisation.oci-containers.backend` says otherwise); the media service runs natively as a
sandboxed systemd unit with read-only access to `libraryDirs`. The service user must be able to
read them; add a group with `users.users.movies.extraGroups` if your files are not
world-readable.

Every setting has an option (`nixos-option services.media` lists them); `extraEnvironment` sets
anything else, and `environmentFile` keeps secrets out of the Nix store. The flake also exports
`packages.<system>.movies`, `overlays.default` (`pkgs.movies`), and a VM test
(`nix build .#checks.x86_64-linux.vm`).

## Remote access

### Tailscale (recommended)

Put the host on your tailnet and bind both ports to its Tailscale address (`MEDIA_BIND` or
`listenAddress`). Use the MagicDNS name in both public URLs. Every device on the tailnet can
reach it, and nothing else can. Traffic is encrypted by WireGuard; [movies] itself speaks plain
HTTP.

For HTTPS on the tailnet (needed by some browsers for features like casting), keep the default
`127.0.0.1` bind and let `tailscale serve` terminate TLS with the tailnet's certificate:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve --bg --https=8443 http://127.0.0.1:3210
```

and set `MEDIA_BASE_URL=https://nas.tailnet.ts.net` and
`CONVEX_PUBLIC_URL=https://nas.tailnet.ts.net:8443` (`publicUrl` and `convexPublicUrl`).

### Caddy on your LAN

A reverse proxy with TLS for a LAN name, with [movies] bound to `127.0.0.1`. The Convex port
carries a WebSocket, which Caddy proxies as is.

```caddyfile
movies.home.arpa {
	tls internal
	reverse_proxy 127.0.0.1:8080
}

convex.movies.home.arpa {
	tls internal
	reverse_proxy 127.0.0.1:3210
}
```

Set `MEDIA_BASE_URL=https://movies.home.arpa` and
`CONVEX_PUBLIC_URL=https://convex.movies.home.arpa`. Every browser and phone must trust
Caddy's local root CA: copy `pki/authorities/local/root.crt` from Caddy's data folder (such as
`/var/lib/caddy/.local/share/caddy` on NixOS) to each device and install it as a trusted root.
`caddy trust` only installs it on the machine Caddy runs on. On NixOS,
`services.caddy.virtualHosts` takes the same blocks. Keep the proxy on the LAN or tailnet; do not port-forward it.

## GPU transcoding

Most plays need no transcoding: [movies] streams the original file or remuxes it. When a device
cannot play the video, the media service transcodes, on the GPU when it can and in software (up
to 1080p) otherwise. `GET /api/health` reports what it found.

**Intel Quick Sync** (Gen12 and newer iGPUs, Tiger Lake onwards, and Arc cards) is what the
service uses today.

- Compose: `docker compose -f compose.yaml -f compose.qsv.yaml up -d` passes `/dev/dri` through
  and sets `HARDWARE_ACCELERATION=qsv`. The amd64 image carries Intel's iHD VA-API driver and the
  oneVPL runtime. `QSV_DEVICE` picks another render node on hosts with several GPUs
  (`ls -l /dev/dri/by-path`).
- NixOS: `hardwareAcceleration = "qsv"` enables `hardware.graphics` with `intel-media-driver` and
  `vpl-gpu-rt`. `"auto"` (the default) gives the service the render nodes and probes them without
  touching the host's graphics configuration; `"none"` keeps it away from the GPU.

**Render group.** The service must open `/dev/dri/renderD128`, which is owned by the host's
`render` group (`stat -c '%G %g' /dev/dri/renderD128`). The image's entrypoint adds the media
user to whichever group owns each passed-through render node, so the GID need not match inside
the container. On NixOS the module adds the `movies` user to `render` and `video` and allows the
DRM devices in the unit's sandbox whenever `hardwareAcceleration` is not `none`. With rootless
Podman, add `--group-add keep-groups` so the container keeps your user's `render` membership.

**Intel and AMD VA-API**, for AMD GPUs, older Intel iGPUs, and any ffmpeg without Quick Sync. The
passthrough is the same (`/dev/dri`, the render group), and the amd64 image carries Intel's iHD
and Mesa's AMD VA-API drivers. `LIBVA_DRIVER_NAME` (`iHD` for Intel, `radeonsi` for AMD) overrides
the driver libva detects.

- Compose: `docker compose -f compose.yaml -f compose.vaapi.yaml up -d` sets
  `HARDWARE_ACCELERATION=vaapi`; `VAAPI_DEVICE` picks another render node.
- NixOS: `hardwareAcceleration = "vaapi"` enables `hardware.graphics` with `intel-media-driver`
  (Mesa provides AMD's driver); `vaapiDevice` picks the node.
- `auto` tries Quick Sync first, then VA-API, then software. HDR is tone-mapped on the GPU
  (`tonemap_vaapi`, Intel); a GPU that cannot fails over to software, which tone-maps with
  `zscale` when the ffmpeg build has it.
- Check a host by hand with the same pipeline the service runs (the render node may differ):
  `ffmpeg -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -hwaccel vaapi
  -hwaccel_output_format vaapi -hwaccel_device va -i input.mkv -t 10 -vf
  scale_vaapi=w=1280:h=720:format=nv12 -c:v h264_vaapi -b:v 4000000 -f null -`.

Check the GPU from inside the container:

```sh
docker compose exec -u movies movies vainfo --display drm --device /dev/dri/renderD128
```

## Where data lives

| What                                   | Compose                               | NixOS                          |
| -------------------------------------- | ------------------------------------- | ------------------------------ |
| Database, file storage, Convex secrets | `convex-data` volume                  | `/var/lib/movies/convex`       |
| Service state and caches               | `movies-data` volume, `/data/media`   | `/var/lib/movies/media`        |
| Nightly backups                        | `movies-data` volume, `/data/backups` | `/var/lib/movies/backups`      |
| `media` CLI logins                     | `movies-data` volume, `/data/config`  | each user's `~/.config/movies` |
| Transcode segments (disposable)        | `movies-transcode` volume             | `/var/cache/movies/transcode`  |
| Your library                           | read-only bind mounts under `/media`  | `libraryDirs`, read-only       |

Volumes are named `movies_<name>` (`docker volume inspect movies_convex-data`). To keep backups on
another disk, bind a host folder over them: `- /srv/backups/movies:/data/backups` under the
`movies` service's `volumes:` (or `backupDir` on NixOS). Transcode segments can live in memory:
replace the `movies-transcode` line with
`- { type: tmpfs, target: /transcode, tmpfs: { size: 8g } }`, sized above `MIN_FREE_TRANSCODE_MB`
plus a few GB per stream.

## Backups

Every night at 03:00 UTC the media service exports the whole database, file storage included,
into the backup folder and keeps `BACKUP_RETENTION_DAYS` (14) days. Each upgrade backs up first.
Back up now with Admin → Backups or `media backup --wait`.

Copy the archives off the box with your usual tool (restic, borg, rsync) from the backup folder.
They hold password hashes, so store them as carefully as the server. Restoring, including onto a
new machine: `docs/operations.md`.

## Upgrading

Compose: keep the checkout and the image on the same release, since `compose.yaml` pins the
Convex backend that release's image was built for (the image logs a warning when they differ).

```sh
cd media && git fetch --tags && git checkout v0.2.0
# in deploy/compose/.env: MEDIA_IMAGE=ghcr.io/lmdevv/media:0.2.0
cd deploy/compose && docker compose pull && docker compose up -d
```

For the edge, `git pull` on `main` with `MEDIA_IMAGE=ghcr.io/lmdevv/media:main`.

NixOS: `nix flake update movies && nixos-rebuild switch` (or move the pinned tag). Both back up
before the new version deploys its functions; `docs/operations.md` ("Upgrading") covers rolling
back.
