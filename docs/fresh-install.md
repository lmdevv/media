# Fresh install

The exact steps to install [media] from a release tag, `v0.4.0` here, on a host that already runs
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

| What            | Example                                                  | Check                                                   |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Port            | `8099`                                                   | `ss -ltn \| grep -w 8099` prints nothing                |
| Listen address  | `127.0.0.1`, or the host's Tailscale address             | [homelab.md](homelab.md#remote-access)                  |
| Public URL      | `http://localhost:8099`                                  | The address browsers, phones, and the CLI open          |
| Data folder     | Compose: the project's volumes; NixOS: `/var/lib/media`  | Not used by another install                             |
| Library folders | `/srv/media/movies`, `/srv/media/tv`, `/srv/media/music` | Readable by the service user; [media] never writes them |

The public URL must be exactly what people type, with the port, since the web clients reach the
database at `<public URL>/convex`.

## Docker Compose

Needs Docker 28 or later with Compose v2.

### Check out the release

Keep the checkout and the image on the same release: `compose.yaml` passes the settings its own
release's image reads.

```sh
git clone --branch v0.4.0 --depth 1 https://github.com/lmdevv/media media-0.4.0
cd media-0.4.0/deploy/compose
cp .env.example .env
docker compose ls      # the projects already running here
```

### Settings

Edit `.env`:

```sh
MEDIA_IMAGE=ghcr.io/lmdevv/media:0.4.0
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
  reads it.
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
  leave `MEDIA_LIBRARY` empty and set `COMPOSE_FILE=compose.yaml:compose.demo.yaml`
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

Check that the library is read-only from inside the container. Each write must fail with
`Read-only file system`:

```sh
docker compose exec media touch /media/library/.write-test
```

Then continue with [First run](#first-run).

## NixOS

The module runs the core's Convex backend as an OCI container (`<backend>-media-core-convex`,
Docker or Podman per `virtualisation.oci-containers.backend`), the media service natively as the
sandboxed `movies` unit, and Caddy on the one port as the `media-proxy` unit.

### Beside an old [movies] install

At `v0.4.0` the module names its media service unit `movies` and its runtime folder
`/run/movies`, the same names as [movies] v0.2's module (`services.movies`). A host that imports
both modules fails to build with:

```text
error: The option `systemd.services.movies.serviceConfig.ExecStart' has conflicting definition values
```

On such a host, run this release with the image under [Docker Compose](#docker-compose), or stop
and remove the old module before you add this one. A host without [movies] v0.2's module has no
conflict. The old installs that run as containers, such as [music] v0.3, don't conflict either.

### Add the release to the flake

Pin the tag, and use the release's own build, made with the nixpkgs it was tested with:

```nix
# flake.nix
inputs.media.url = "github:lmdevv/media/v0.4.0";
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
    package = release.movies;
    port = 8099;
    listenAddress = "127.0.0.1";                   # or the host's Tailscale address
    publicUrl = "http://localhost:8099";
    dataDir = "/var/lib/media";                    # a new, empty folder
    transcodeDir = "/var/cache/media/transcode";   # not shared with another install
    internalPorts = {
      coreConvex = 3210;                           # loopback; pick free ones
      media = 4300;
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
  must be free too (`ss -ltn`).
- **Library access.** The `movies` user must read every library folder. Files and folders that
  are world-readable need nothing more; otherwise add the group that can read them, as in
  `users.users.movies.extraGroups = [ "media" ];`. The unit mounts each folder read-only.
- **Secrets.** `tmdbApiKeyFile` and `omdbApiKeyFile` take files outside the Nix store, such as
  sops-nix or agenix secrets.
- **GPU.** `hardwareAcceleration` defaults to `auto`
  ([homelab.md](homelab.md#gpu-transcoding)).

### Switch and check

```sh
sudo nixos-rebuild switch --flake .#<host>
systemctl status movies media-proxy docker-media-core-convex   # podman-… with Podman
journalctl -u movies -f
curl -fsS http://localhost:8099/api/health
```

The first start pulls the pinned Convex image, deploys the database functions, and issues the
media service its key, which takes a minute or two. The health answer includes
`"backend":"connected"` when it is done.

Check that the library is read-only to the service. Each write must fail:

```sh
pid="$(systemctl show -p MainPID --value movies)"
sudo nsenter -t "$pid" -m touch /srv/media/movies/.write-test
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
it, already pointed at the server.

```sh
printf '%s' "$PASSWORD" | media auth login --username <owner>
media auth libraries list
media auth libraries get --library-id <id>     # items, and the scan's status
media admin jobs list --status failed          # empty when every scan went through
```

## Check health

| Check                   | Compose                                                              | NixOS                                                             |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Services up             | `docker compose ps` shows `(healthy)`                                | `systemctl is-active movies media-proxy docker-media-core-convex` |
| Media service signed in | `curl -fsS <public URL>/api/health` includes `"backend":"connected"` | the same                                                          |
| Logs                    | `docker compose logs media`                                          | `journalctl -u movies -u media-proxy`                             |
| Scans                   | `media admin jobs list --status failed` is empty                     | the same                                                          |

A restart keeps everything: `docker compose restart`, or `sudo systemctl restart movies` (which
also redeploys the functions, as every start does). The libraries stay scanned, and the next
reconciliation picks up files that changed while it was down.

## Idle memory

Read memory after five idle minutes, with no stream playing.

- **Compose:** `docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'`. The one `media`
  container holds every service.
- **NixOS:** `systemd-cgtop -m -b -n 1 --raw` lists each unit's memory. [media] is the sum of
  `movies.service`, `media-proxy.service`, and the Convex container. Docker runs the container
  outside the unit that starts it, in its own scope,
  `docker-$(docker inspect -f '{{.Id}}' media-core-convex).scope`; with Podman, read it with
  `podman stats --no-stream media-core-convex`.
