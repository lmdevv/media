# Operating [music]

Backups, restores, upgrades, health checks, and who can read what inside the container. The
examples assume a container named `music` with its data in a volume or folder mounted at `/data`;
on NixOS the container is also named `music` and its data lives in `services.music.dataDir`
(`/var/lib/music`).

## What lives in `/data`

| Path              | Contents                                                 | Owner (in the container) |
| ----------------- | -------------------------------------------------------- | ------------------------ |
| `convex/`         | The database (`db.sqlite3`) and Convex file storage      | `convex` (uid 901), 700  |
| `media/`          | Artwork and the transcode cache; both can be rebuilt     | `music` (PUID), 750      |
| `secrets/`        | Generated instance secret, admin key, and media secret   | root, 700                |
| `backups/`        | `pre-*.zip` exports taken before upgrades                | root, 700                |
| `build`/`version` | The build and version the last successful start deployed | root                     |

Your music is never in `/data`: it is mounted read-only (at `/music` in the examples) and never
written to.

## Backups

**Automatic, before every upgrade.** Each image carries a build identity: a hash of the Convex
functions, schema, and migrations it deploys, and of the Convex backend it runs. On start, when it
differs from the one recorded in `/data/build`, the container exports the database to
`/data/backups/pre-<version>-<build>-<time>.zip` _before_ it deploys anything, so a `:main` image
with a schema change is backed up just like a release. A failed export stops the start. A start
that fails after the export reuses that backup when it retries, rather than taking (and pruning
for) another one.

Only the newest `BACKUP_KEEP` backups (default `5`) are kept; set `BACKUP_KEEP=0` to keep all of
them. A restart of the same image takes no backup.

**On demand.** Export the database while the container runs:

```sh
docker exec music sh -c 'cd /app/backend && CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /data/secrets/admin_key)" \
  ./node_modules/.bin/convex export --path /data/backups/manual-$(date +%Y%m%d).zip'
```

Copy backups somewhere else (`docker cp music:/data/backups ./music-backups`, or from the host
folder you mounted at `/data`). The exports hold every account, playlist, and API key hash, so keep
them private.

**Whole volume.** For a full copy, including secrets and artwork, stop the container and archive
the volume:

```sh
docker stop music
docker run --rm -v music-data:/data -v "$PWD":/backup debian:trixie-slim \
  tar -C /data -czf /backup/music-data.tar.gz .
docker start music
```

## Restore

A `pre-*.zip` holds the data as the version _before_ the upgrade stored it; its name says which
(`pre-<new version>-<build>-from-<old version>-<time>.zip`). Every newer version can read data an
older one wrote, but not the other way round, so to undo an upgrade, restore first and change the
image second:

1. While the current image still runs, replace the database with the backup:

   ```sh
   docker exec music /app/bin/restore /data/backups/pre-0.3.0-<build>-from-0.2.0-<time>.zip
   ```

   It replaces every table in the backup, including accounts and sessions, with its contents,
   and records in `/data/version` that the data is now 0.2.0's. It stops the media service
   first, so nothing the current image writes (a folder claim, a scan) lands on the restored data,
   and refuses to restore if it doesn't stop within 30 seconds; the media service starts again
   with the container. A file from outside the container must be
   copied in first: `docker cp ./backup.zip music:/data/backups/`.

2. Start the previous image on the same volume (see [Pin a version](#pin-a-version)). It deploys
   its own functions again over the restored data.

An image refuses to start on data a newer version has used, before it exports or deploys
anything, and says so in its log (`[init] refusing to start: ...`). Starting an older image
without step 1 therefore stops there; run the newer image again and follow the steps.

To restore without going back to an older image, run only step 1, then `docker restart music` so
the data migrations run over the restored rows. `scripts/upgrade-e2e.sh` runs this whole round
trip in CI: 0.1.0, an upgrade to the new image, a refused start on newer data, a restore, and back
to 0.1.0.

The same command restores any export into a new install: start the image on an empty volume,
wait for it to report healthy, and run `/app/bin/restore` on the file. People sign in again; their
API keys keep working.

## Upgrade

Images on `ghcr.io/lmdevv/music` are published only after every CI check has passed. A release is
a tag such as `v0.2.0` in the repository; its images drop the `v`:

| Tag           | What it is                                             |
| ------------- | ------------------------------------------------------ |
| `0.2.0`       | A release. Never changes.                              |
| `0.2`         | The newest release in that minor series.               |
| `latest`      | The newest release.                                    |
| `main`        | The newest commit on `main`. Moves often; for testing. |
| `sha-<short>` | One commit from `main` or a release.                   |

### Pin a version

Run a release tag such as `0.2.0` and change it to upgrade. Every start of a new build backs up
first, so upgrading (or going back) is: change the tag, then recreate the container.

### Docker

```sh
docker pull ghcr.io/lmdevv/music:0.2.0
docker stop music && docker rm music   # stop lets the database shut down cleanly
docker run -d --name music -p 8080:8080 -v music-data:/data -v /path/to/music:/music:ro \
  -e PUBLIC_URL=https://music.example.com ghcr.io/lmdevv/music:0.2.0
```

### Docker Compose

Set the tag (`MUSIC_VERSION=0.2.0` in the `.env` next to `compose.yaml`), then:

```sh
docker compose pull && docker compose up -d
```

With a moving tag (`latest` or `main`), `docker compose pull && docker compose up -d` fetches and
starts the new image.

### NixOS

By default the module runs the release its flake revision was cut for
(`ghcr.io/lmdevv/music:<version>`), so updating the flake input and rebuilding is the upgrade:

```sh
nix flake update music && sudo nixos-rebuild switch
```

The module runs the image with `virtualisation.oci-containers`, which pulls an image once and
keeps using that copy: a moving tag such as `latest` or `main` does **not** update on its own.
To follow one, have it pulled on every service start, or let a timer check for you:

```nix
services.music = {
  image = "ghcr.io/lmdevv/music:latest";
  pull = "newer";           # on every start of podman-music (or docker-music) ...
  autoUpdate.enable = true; # ... and daily: pull, and restart only if the image changed
};
```

`imageFile` loads an image archive from the Nix store instead of pulling, for example a
`dockerTools.pullImage` pinned by digest; its name and tag must equal `image`.

## Health

`GET /healthz` answers `200` with `{"ok":true,"convex":true,"ffmpeg":true,...}` only while Caddy,
the media service, and Convex all work: Caddy proxies it to the media service's health check,
which queries Convex and checks ffmpeg. It answers `502` while the media service is down or still
starting and `503` when it cannot reach Convex or run ffmpeg. Point uptime monitors at it.

The image's `HEALTHCHECK` uses the same endpoint: every 5 seconds while starting, so `docker ps`
shows `healthy` as soon as everything is up, then every 30 seconds. Failures in the first 10
minutes don't count, because an upgrade backs up and deploys before the media service starts and
can take minutes on a large database. Keep any autoheal or orchestrator restart policy at least as
patient, or it may restart the container in the middle of an upgrade.

Logs from every service go to the container's output: `docker logs -f music` (or
`journalctl -u podman-music` on NixOS).

## Permissions

Every service runs as its own unprivileged user; only the start-up script runs as root.

| Process                    | User                    | Reads                           | Writes             |
| -------------------------- | ----------------------- | ------------------------------- | ------------------ |
| Start-up (`/app/bin/init`) | root                    | everything                      | secrets, backups   |
| Convex backend             | `convex` (uid/gid 901)  | its copy of the instance secret | `/data/convex`     |
| Caddy (port 8080)          | `caddy` (uid/gid 902)   | its config and the web app      | nothing persistent |
| Media service and ffmpeg   | `music` (`PUID`/`PGID`) | your music, its own env file    | `/data/media`      |

- `PUID`/`PGID` (default 1000; the NixOS module's `uid`/`gid`) must be able to read your music;
  ordinary `644` files in `755` folders are fine. They cannot be 0, 901, or 902.
- Ownership is fixed on every start: `/data/media` goes to the media user (also after `PUID`
  changes), and `/data/convex` to the Convex user (earlier images ran Convex as root).
- The media service, which parses every file in your library with ffmpeg, cannot read the
  database, the secrets, or the backups. The Convex instance secret, which would let a process
  become a Convex admin, is never on a command line (any process can read every other's in
  `/proc`): the backend and the key generator read it from a file through a small preloaded
  shim. CI checks that the media user cannot find it in any `/proc/*/cmdline` or
  `/proc/*/environ`.
- Container ports bypass a NixOS firewall; the module publishes on `127.0.0.1` unless
  `openFirewall` is set.

## Accounts and access

- **Roles.** The first account is the `owner`: it can do everything, can't be demoted, suspended,
  or removed, and can hand ownership to an admin. `admin`s run people, invites, libraries, and
  jobs, but only the owner changes, suspends, resets, or removes another admin. `member`s listen
  and keep their own playlists, likes, history, and API keys. `guest`s only hear the libraries
  they were added to, and any they own (from before they became a guest), and have no API keys.
- **Libraries.** `shared` is everyone but guests, `restricted` is only the people added, and
  `private` is only the library's owner. Private hides a library from other members and admins,
  not from the server's owner: they run the machine and can always reach the files, directly or
  by removing the person (whose libraries then go to them), and they could remove the library and
  add its folder again as their own. Either is visible to the library's owner, and the server's
  owner can never quietly let anyone into someone else's library. Admins rename and rescan the libraries they can listen
  to; the server's owner manages every library. Only a library's own owner, or the
  server's owner, removes it. Admins see that the other libraries exist (name, owner,
  visibility, song count) but not their folders. Only a library's own owner changes who listens
  to it, while they are an admin. Once they aren't (demoted or suspended), the server's owner may
  only let fewer people in: take people out, or make it more private. When someone is
  removed, their libraries move to the server's owner.
- **Library folders (`MUSIC_ROOTS`).** Before every scan the media service resolves a library's
  folder through links and claims it, with the device and inode of the folder and of each folder
  above it, which a bind mount can't change, and where the folder sits on its file system (from the
  mount table). Those numbers can change across reboots, so they count only within one boot, and
  the media service claims every library again within seconds of starting. A folder that is, sits inside, or holds another
  library's folder, by path or by identity, is not scanned, and the job says so without naming
  the other folder. Library folders must also be inside `MUSIC_ROOTS` (comma-separated absolute
  folders): the image sets `/music`, where Docker, Compose, and the NixOS module mount your music,
  so a folder elsewhere (or a link out of `/music`) is refused. Set `MUSIC_ROOTS` on the container
  to allow others; outside the image (development) it is unset and every folder is allowed.
  `/` itself, and folders in `/proc`, `/sys`, and `/dev`, are always refused. A library whose folder is
  refused stops streaming until a scan claims it again; its songs stay listed. The media service
  claims every unclaimed library as soon as it sees it, ahead of the scan queue, so after an
  upgrade every library streams again within seconds; their full scans, which the upgrade also
  starts, follow one at a time.
- **Known limit: two names for one folder.** When two libraries name the same folder (one through
  a bind mount, which only a path check can't see), the library added first keeps it, even if the
  newer one's scan claimed it first: the newer one stops streaming and its scans fail. Songs the
  newer library indexed before that stay listed in it until it is removed, so remove it.
- **Suspend and remove** end the person's sessions and API key sign-ins at once.
- **Password reset without email.** An admin makes a one-time link in Settings → People (or
  `music people reset <user-id>`); it lasts 24 hours, and stops working if its maker loses the
  right to reset that person (demoted, suspended, removed, the person became an admin, or the
  person was let into a library the maker can't hear). If the
  owner is locked out, make a link with the admin key:

  ```sh
  docker exec music sh -c 'cd /app/backend && CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
    CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /data/secrets/admin_key)" \
    ./node_modules/.bin/convex run passwordResets:createForEmail "{\"email\": \"you@example.com\"}"'
  ```

  Open `https://<your host>` + the `path` it prints.

- **Known limit: sign-in rate limit.** After 10 wrong passwords an existing account answers
  "Too many failed sign-ins" for a while; an email with no account never does. Someone who tries
  more than 10 passwords can tell the two apart.
- **Known limit: folder paths.** Adding a library refuses a folder that is, is inside, or contains
  another library's folder (so no files are indexed twice); for a library you can't hear it says
  only "This folder overlaps another library", naming no folder. An admin who guesses folder
  paths can still learn that one is taken.
- **Known limit: signed stream URLs.** A stream or artwork URL is signed for whoever asked for it
  and works without a session until it expires: up to 6 hours for streams (artwork URLs follow a
  weekly schedule). After someone is suspended, removed, or loses access to a library, URLs they
  already fetched keep working until then; they can't get new ones.
