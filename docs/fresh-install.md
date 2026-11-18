# Fresh install

The exact steps to install [media] from a release tag, `v0.4.1` here, on a host that already runs
other things: an old [movies] or [music] install, Jellyfin, or anything else. [media] gets its own
port and its own data folder, mounts the library read-only, and leaves the other installs alone.
There are two methods, the image under Docker Compose and the NixOS module; pick one. Both end in
the same first run: the owner account, one library per kind, the first scan, and a play.

[homelab.md](homelab.md) explains the parts this page only uses: remote access, GPU transcoding,
where data lives, backups, and upgrading. Nothing moves over from [movies] v0.2 or [music] v0.3
([operations.md](operations.md#upgrading)): accounts, libraries, and history start empty, and the
old install keeps running as it was until you stop it.

## Plan

Decide these first. Every later step uses them.

| What            | Example                                                  | Check                                                                |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Port            | `8099`                                                   | `ss -ltn \| grep -w 8099` and `docker ps \| grep 8099` print nothing |
| Listen address  | `127.0.0.1`, or the host's Tailscale address             | [homelab.md](homelab.md#remote-access)                               |
| Public URL      | `http://localhost:8099`                                  | The address browsers, phones, and the CLI open                       |
| Data folder     | Compose: the project's volumes; NixOS: `/var/lib/media`  | Not used by another install                                          |
| Library folders | `/srv/media/movies`, `/srv/media/tv`, `/srv/media/music` | Readable by the service user; [media] never writes them              |

The public URL must be exactly what people type, with the port, since the web clients reach the
database at `<public URL>/convex`.

## Docker Compose

Needs Docker 28 or later with Compose v2.

### Check out the release

Keep the checkout and the image on the same release: `compose.yaml` passes the settings its own
release's image reads.

```sh
git clone --branch v0.4.1 --depth 1 https://github.com/lmdevv/media media-0.4.1
cd media-0.4.1/deploy/compose
cp .env.example .env
docker compose ls      # the projects already running here
```

### Settings

Edit `.env`:

```sh
MEDIA_IMAGE=ghcr.io/lmdevv/media:0.4.1
MEDIA_PORT=8099
MEDIA_BIND=127.0.0.1
MEDIA_BASE_URL=http://localhost:8099
MEDIA_LIBRARY=/srv/media             # mounted read-only at /media/library
PUID=1000                             # a user that can read the library (`id -u you`)
PGID=1000
```

- **Project name.** `compose.yaml` names the project `media`, and its volumes
  `media_media-data` and `media_media-transcode`. If `docker compose ls` or `docker volume ls`
  already shows that name, add `COMPOSE_PROJECT_NAME=media-new` (any unused name) to `.env`; the
  volumes then take that prefix.
- **Data folder.** Everything [media] keeps lives in the project's `media-data` volume. To keep it
  in a host folder instead, put the override below in `compose.local.yaml` and add
  `COMPOSE_FILE=compose.yaml:compose.local.yaml` to `.env`, so every `docker compose` command
  reads it. Choose it before the first start: the database starts empty wherever `/data` points.
- **More library folders.** Each extra folder is one read-only line in the same override.

```yaml
# compose.local.yaml
services:
  media:
    volumes:
      - /srv/media-data:/data # a new, empty folder
      - /mnt/nas/music:/media/music:ro # an extra library folder, read-only
```

- **Demo library.** To try [media] on the Creative Commons demo library instead of your own,
  leave `MEDIA_LIBRARY` empty and add `compose.demo.yaml` to `COMPOSE_FILE`, after `compose.yaml`
  and before any override of yours: `COMPOSE_FILE=compose.yaml:compose.demo.yaml:compose.local.yaml`
  ([demo-library.md](demo-library.md)).

### Start it

```sh
docker compose pull
docker compose up -d
docker compose ps                    # media turns (healthy) after about a minute
curl -fsS http://localhost:8099/api/health
```

The first start deploys the database functions, configures the core, and issues the media
service its key. `docker compose logs -f media` shows it. The health answer includes
`"backend":"connected"` once the media service has signed in to the core.

Check that every library folder is read-only from inside the container, even for root. Each one
must print `read-only`; a folder that takes the test file is named and cleaned up:

```sh
docker compose exec media sh -c 'for d in /media/*; do
  if touch "$d/.write-test" 2>/dev/null; then rm "$d/.write-test"; echo "WRITABLE: $d"; else echo "read-only: $d"; fi
done'
```

Then continue with [First run](#first-run).

## NixOS

The module runs the core's Convex backend as an OCI container (`<backend>-media-core-convex`,
Docker or Podman per `virtualisation.oci-containers.backend`), the media service natively as the
sandboxed `media-server` unit, and Caddy on the one port as the `media-proxy` unit.

### Beside the old installs

From `v0.4.1` everything the module makes has a `media` name, and the old [movies] v0.2 and
[music] v0.3 modules use `movies` and `music` names, so one host can import all three (ADR 0029).
They share only the library folders, which each mounts read-only.

| What           | [media]                                                                              | [movies] v0.2                        | [music] v0.3                      |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------- |
| Options        | `services.media`, `programs.media`                                                   | `services.movies`, `programs.movies` | `services.music`                  |
| Units          | `media-server`, `media-server-folders`, `media-proxy`, `<backend>-media-core-convex` | `movies`, `<backend>-movies-convex`  | `<backend>-music`, `music-update` |
| User and group | `media-server`                                                                       | `movies`                             | the container's ids               |
| State          | `/var/lib/media`                                                                     | `/var/lib/movies`                    | `/var/lib/music`                  |
| Cache          | `/var/cache/media/transcode`                                                         | `/var/cache/movies/transcode`        | in its state folder               |
| Runtime        | `/run/media-server`, `/run/media-proxy`, `/run/media-account`, `/run/media-music`    | `/run/movies`                        | none                              |

Pick a `port` and `internalPorts` that none of them uses, and keep `dataDir`, `backupDir`, and
`transcodeDir` apart from their folders: evaluation refuses only one that is, holds, or sits inside
a library. At `v0.4.0` the module still used
`movies` names, and a host that imported it beside [movies] v0.2's module failed to evaluate.

### Add the release to the flake

Pin the tag, and use the release's own build, made with the nixpkgs it was tested with. To
upgrade later, move the tag and run `nix flake update media`.

```nix
# flake.nix
inputs.media.url = "github:lmdevv/media/v0.4.1";
```

```nix
# a module in the host's nixosSystem, with inputs passed in (specialArgs)
{ inputs, pkgs, ... }:
let
  release = inputs.media.packages.${pkgs.stdenv.hostPlatform.system};
in
{
  imports = [ inputs.media.nixosModules.default ];

  services.media = {
    enable = true;
    package = release.media;
    port = 8099;
    listenAddress = "127.0.0.1";                   # or the host's Tailscale address
    publicUrl = "http://localhost:8099";
    dataDir = "/var/lib/media";                    # a new, empty folder
    transcodeDir = "/var/cache/media/transcode";   # not shared with another install
    internalPorts = {
      coreConvex = 3240;                           # loopback; not 3210, [movies] v0.2's
      media = 4310;
    };
    libraryDirs = [
      "/srv/media/movies"
      "/srv/media/tv"
      "/srv/media/music"
    ];
  };
  programs.media.package = release.cli;
}
```

- **Ports.** `port` is the only one people use. The two `internalPorts` listen on loopback, and
  must be free too (`ss -ltn`). Their defaults, 3210 and 4300, are Convex's usual port, which
  [movies] v0.2's backend also takes by default, so pick others beside it.
- **Library access.** The `media-server` user must read every library folder. Files and folders
  that are world-readable need nothing more; otherwise add the group that can read them, as in
  `users.users.media-server.extraGroups = [ "media" ];`. The unit mounts each folder read-only.
- **Folders.** The module makes `dataDir`, `backupDir`, and `transcodeDir` and changes the owner
  of nothing that is already there. Each must be a plain folder: no symlink on its path, and not a
  mount point, so to use a disk of its own, mount it elsewhere and point the option at a folder
  inside it. `media-server-folders` checks this before every start, and
  `journalctl -u media-server-folders` says what to fix.
- **Secrets.** `tmdbApiKeyFile` and `omdbApiKeyFile` take files outside the Nix store, such as
  sops-nix or agenix secrets.
- **GPU.** `hardwareAcceleration` defaults to `auto`
  ([homelab.md](homelab.md#gpu-transcoding)).

### Switch and check

The Convex container's unit is `docker-media-core-convex` with Docker and
`podman-media-core-convex` with Podman, NixOS's default. The commands on this page use Docker's
name; with Podman, use the other.

```sh
sudo nixos-rebuild switch --flake .#<host>
systemctl status media-server media-proxy docker-media-core-convex
journalctl -u media-server -f
curl -fsS http://localhost:8099/api/health
```

The first start pulls the pinned Convex image, deploys the database functions, and issues the
media service its key, which takes about two minutes. The health answer includes
`"backend":"connected"` when it is done.

Then check that every library folder is read-only to the service, even for root. The service's
main process exists only once the health answer reports connected. Each folder must print
`read-only`:

```sh
pid="$(systemctl show -p MainPID --value media-server)"; [ "$pid" != 0 ] || echo "not running yet"
for d in /srv/media/movies /srv/media/tv /srv/media/music; do
  if sudo nsenter -t "$pid" -m touch "$d/.write-test" 2>/dev/null; then
    sudo rm "$d/.write-test"; echo "WRITABLE: $d"
  else echo "read-only: $d"; fi
done
```

## First run

The same for both methods. Open the public URL in a browser.

1. **Owner account.** On a new server the account client asks you to `Set up your server.`
   Choose a username and password and press `Create owner account`. The first account is the
   owner; everyone else joins from an invite link the owner makes under Admin, Users.
2. **Libraries, one per kind.** Under Admin, Libraries, `Add a library` takes a name, a kind
   (`Movies` or `Music`), and folders, one per line. Movies and shows share the Movies kind, so
   one Movies library can hold both folders:

   | Name     | Kind     | Folders (Compose)                           | Folders (NixOS)                     |
   | -------- | -------- | ------------------------------------------- | ----------------------------------- |
   | `Movies` | `Movies` | `/media/library/movies` `/media/library/tv` | `/srv/media/movies` `/srv/media/tv` |
   | `Music`  | `Music`  | `/media/library/music`                      | `/srv/media/music`                  |

   With Compose, the folders are the paths inside the container: `MEDIA_LIBRARY` is
   `/media/library`, and each extra line of the override names its own.

3. **First scan.** `Add library` queues the library's first scan. Its page under Admin, Libraries
   reads `Scanning n of m files`, then `Scanned` with the time. A library is private to whoever
   made it until it is shared from that page.
4. **Play.** Open `/movies`, pick a movie, and press `Play`; music is at `/music`. The same
   sign-in opens both.

The `media` CLI does the same from a terminal ([README.md](../README.md#cli)). With Compose it is
in the image: prefix each command with `docker compose exec -T media`. On NixOS the module installs
it, pointed at the server through session variables that a shell gets at its next login.

```sh
printf '%s' "$PASSWORD" | media auth login --username <owner>
media auth libraries list
media auth libraries get --library-id <id>     # items, and the scan's status
media admin jobs list --status failed          # empty when every scan went through
```

## Check health

| Check                   | Compose                                                              | NixOS                                                                   |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Services up             | `docker compose ps` shows `(healthy)`                                | `systemctl is-active media-server media-proxy docker-media-core-convex` |
| Media service signed in | `curl -fsS <public URL>/api/health` includes `"backend":"connected"` | the same                                                                |
| Logs                    | `docker compose logs media`                                          | `journalctl -u media-server -u media-proxy`                             |
| Scans                   | `media admin jobs list --status failed` is empty                     | the same                                                                |

A restart keeps everything: `docker compose restart`, or
`sudo systemctl restart docker-media-core-convex media-server media-proxy`. Each start redeploys the
functions, which takes seconds once the image is pulled. The libraries stay scanned, and the next
reconciliation picks up files that changed while it was down.

## Idle memory

Read memory after five idle minutes, with no stream playing.

- **Compose:** `docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'`. The one `media`
  container holds every service.
- **NixOS:** `systemd-cgtop -m -b -n 1 --raw` lists each unit's memory. [media] is the sum of
  `media-server.service`, `media-proxy.service`, `docker-media-core-convex.service` (which holds
  the `docker run` client), and the Convex container itself. Docker, with the systemd cgroup driver
  it uses on cgroup v2, runs the container outside the unit that starts it, in its own scope,
  `docker-$(sudo docker inspect -f '{{.Id}}' media-core-convex).scope`; with Podman, read it with
  `sudo podman stats --no-stream media-core-convex`. Most of `memory.current` right after a scan
  is page cache, which `docker stats` leaves out; compare installs the same way.
