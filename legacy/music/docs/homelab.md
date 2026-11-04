# Running [music] at home

One container serves the web app, the API, and your music on one port. This page gets it running
with Docker Compose or NixOS, behind a reverse proxy or Tailscale, and kept up to date. Backups,
restores, health checks, and permissions are covered in depth in
[`operations.md`](operations.md).

## What it needs

| Resource | Needs                                                                                    |
| -------- | ---------------------------------------------------------------------------------------- |
| CPU      | `linux/amd64` or `linux/arm64`. 2 cores are comfortable; transcoding uses one per stream |
| Memory   | About 220 MB idle. Allow 1 GB for scans and a few transcoding streams at once            |
| Disk     | 1.2 GB for the image, plus `/data` (below)                                               |

`/data` holds the database, artwork, a transcode cache, and backups:

- The database grows with your library and your listening history. It stays small next to the
  music: a few hundred MB is a lot.
- Artwork is copied out of your files once, usually tens to a few hundred KB per album.
- The transcode cache, for the lower-quality streams on slow connections, is capped at 2 GB
  (`MEDIA_CACHE_MAX_MB`) and cleans up after itself.
- Each pre-upgrade backup is a zip of the database; the newest 5 are kept (`BACKUP_KEEP`).

The memory figure is from `docker stats` on a running server; the rest are estimates, so check
`du -sh` on your own `/data` after the first scan.

## Docker Compose

```sh
mkdir music && cd music
curl -fsSLO https://raw.githubusercontent.com/lmdevv/music/main/deploy/docker/compose.yaml
MUSIC_DIR=/srv/music docker compose up -d
docker compose logs -f        # until "[init] ready"
```

Open <http://your-server:8080>, create the admin account (the first account is the admin), and
add `/music` as a library. The first scan starts at once; albums appear while it runs.

Settings go in an `.env` file next to `compose.yaml`, so `docker compose up -d` picks them up
every time:

```sh
MUSIC_DIR=/srv/music
MUSIC_VERSION=0.3.0             # pin a release; see "Upgrading"
PUBLIC_URL=https://music.example.com
PUID=1000                       # `id -u` of the user that owns your music
PGID=1000                       # `id -g`
TZ=Europe/Berlin
```

The file restarts the container unless you stop it, checks its health every 30 seconds, gives
it 30 seconds to stop cleanly (it needs about 3), and rotates its logs. Several folders of music?
Mount each one under `/music` (for example `- /mnt/rock:/music/rock:ro`) and add each as a
library.

## Reverse proxy

Put the server behind the proxy you already run, set `PUBLIC_URL` to the address people type,
and recreate the container (`docker compose up -d`). Sign-in tokens are issued for `PUBLIC_URL`,
so it must match what the browser shows, `https://` included. Proxy everything, WebSockets
included, to port 8080, and don't put a short read timeout on `/media/`: a stream sits idle while
someone pauses.

When the proxy runs on the same machine, publish the port on localhost only
(`"127.0.0.1:8080:8080"` in `compose.yaml`) so nobody skips the proxy.

**Caddy**

```caddyfile
music.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

**Traefik** (labels on the `music` service, Traefik on the same Docker network, no `ports`):

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.music.rule=Host(`music.example.com`)
  - traefik.http.routers.music.entrypoints=websecure
  - traefik.http.routers.music.tls.certresolver=letsencrypt
  - traefik.http.services.music.loadbalancer.server.port=8080
```

**Nginx Proxy Manager:** add a proxy host for `music.example.com`, forward to the server on port
8080, turn on **Websockets Support**, and request a certificate under **SSL**.

**Tailscale:** to reach it from your devices without opening a port, run
`tailscale serve --bg 8080` on the server and set
`PUBLIC_URL=https://<machine>.<tailnet>.ts.net`. Tailscale provides the HTTPS certificate.

## NixOS

The flake's module runs the same image with Podman (or Docker):

```nix
{
  inputs.music.url = "github:lmdevv/music";

  outputs = { nixpkgs, music, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        music.nixosModules.default
        {
          services.music = {
            enable = true;
            publicUrl = "https://music.example.com";
            musicDirs = [ "/srv/music" ];       # mounted at /music/music
            # musicDirs = { rock = "/a/music"; jazz = "/b/music"; };  # name the mounts
            extraEnvironment.TZ = "Europe/Berlin";
          };
        }
      ];
    };
  };
}
```

- It listens on `127.0.0.1:8080` for a reverse proxy or `tailscale serve`. Set
  `openFirewall = true` to listen on every interface; container ports skip the NixOS firewall,
  so the bind address is what keeps it private.
- `uid`/`gid` choose who reads the music (default 1000), `dataDir` where `/data` lives
  (`/var/lib/music`). It runs on the host's `virtualisation.oci-containers.backend` (Podman
  unless you chose Docker); `backend = "docker"` sets that.
- The image defaults to the release that matches the flake revision, so `nix flake update music`
  followed by `nixos-rebuild switch` is an upgrade. `imageFile` loads an image from the Nix store
  instead of pulling, for example one from `dockerTools.pullImage` pinned by digest.
- The CLI: `nix run github:lmdevv/music#cli -- login --server https://music.example.com/convex`,
  or add `music.packages.${system}.cli` to `environment.systemPackages`.

## Upgrading

Every image carries a build identity. When a start finds that the build changed, it exports the
database to `/data/backups/pre-*.zip` before it touches anything, then deploys and migrates. Each
step is checked in CI: `scripts/upgrade-e2e.sh` starts 0.1.0, upgrades it to the new image on
the same volume, checks that every account, song, and playlist made it, rolls back, and checks
again.

- **Pinned release (recommended):** change `MUSIC_VERSION` (Compose) or update the flake input
  (NixOS), then `docker compose pull && docker compose up -d` or `nixos-rebuild switch`.
- **Moving tag** (`latest`, or `main` for the newest commit): `docker compose pull && docker
  compose up -d` whenever you like. On NixOS a moving tag is pulled only once, so set
  `services.music.image = "ghcr.io/lmdevv/music:latest"` and either `pull = "newer"` (checks on
  every service start) or `autoUpdate.enable = true` (a daily timer that restarts the container
  only when a new image arrived).

Watchtower and similar tools work too; the backup happens on the container's own start.

To go back, restore the backup first, then start the older image; an older image refuses to start on
data a newer one has migrated. The steps are in [`operations.md`](operations.md#restore).

## Backups and restore

The automatic backups only protect against upgrades. For everything else, export now and then
and copy the zips off the machine:

```sh
docker exec music sh -c 'cd /app/backend && CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /data/secrets/admin_key)" \
  ./node_modules/.bin/convex export --path /data/backups/manual-$(date +%Y%m%d).zip'
docker cp music:/data/backups ./music-backups
```

Your music isn't in the backup; back that up as you already do. Restoring is one command,
`docker exec music /app/bin/restore <file>`, described with the rest in [`operations.md`](operations.md#restore).

## Troubleshooting

**Albums are missing, or a scan fails with "permission denied".** The media service reads your
music as `PUID`/`PGID`, never as root. Check with the same ids:

```sh
docker exec -u "$(docker exec music id -u music)" music ls -R /music | head
```

Make files `644` and folders `755` (`chmod -R a+rX /srv/music`), or set `PUID`/`PGID` to the
owner of the files.

**The container stops at start with "PUID and PGID ...".** They must be numbers and cannot be 0,
901, or 902, the ids the database and web server run as.

**New files show up only after an hour.** The media service watches your folders, which costs
one inotify watch per folder. When it runs out, it falls back to a full rescan every hour
(`MEDIA_RESCAN_MINUTES`). Raise the limit on the host, because containers share it:

```sh
sysctl fs.inotify.max_user_watches                      # see the current limit
sudo sysctl -w fs.inotify.max_user_watches=524288       # until reboot
echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-music.conf
```

On NixOS: `boot.kernel.sysctl."fs.inotify.max_user_watches" = 524288;`. Network shares (NFS,
SMB) send no change events at all, so they rely on the hourly rescan.

**The first scan is slow.** Every file is read once with ffprobe and its artwork copied out, so
the first scan of a large library takes a while, longest from a spinning disk or a network
share. Albums appear while it runs, and later scans only read files that changed. Follow its
progress with `music jobs list` or `docker logs -f music`.

**The health check says unhealthy.** Look at `docker logs music`. During the first start or an
upgrade, the media service starts only after the backup and deploy, and Docker allows 10
minutes for that. `curl http://localhost:8080/healthz` names the failing part (`convex` or
`ffmpeg`), or answers 502 while the media service is down.

**Sign-in works on localhost but not through the proxy.** `PUBLIC_URL` must be the proxied
address, `https://` included. Recreate the container after you change it.
