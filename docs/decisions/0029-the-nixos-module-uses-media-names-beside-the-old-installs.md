# 0029. The NixOS module uses media names, so it runs beside the old installs

- Status: Accepted, 2026-11-16.
- Decisions: D03, D58, D69

## Context

The owner's NAS runs [movies] v0.2 through its NixOS module and [music] v0.3 through its own. D69
puts [media] on the same host through [media]'s NixOS module, beside both, on its own port and
data root, until `p8-cutover` stops the old ones.

At 0.4.0 the module still carried names from when it was [movies]'s: the media service's unit was
`movies`, its user and group `movies`, its runtime folder `/run/movies`, and its default
transcode folder `/var/cache/movies/transcode`. [movies] v0.2's module defines the same unit, user,
runtime folder, and transcode folder. A host that imports both fails to evaluate, with conflicting
definitions for `systemd.services.movies`. Had they merged, stopping either unit would have deleted
the other's `/run/movies`, and the two would have shared one transcode folder.

[music] v0.3's module uses `services.music`, the `music` container, the `music-update` units, and
`/var/lib/music`, with numeric ids instead of a user, so it collides with neither.

## Decision

- Everything the module makes has a media name: the unit and its user and group `media-server`,
  the runtime folder `/run/media-server`, and the default transcode folder
  `/var/cache/media/transcode`, beside the existing `media-proxy`, `media-core-convex`,
  `/run/media-proxy`, `/run/media-account`, `/run/media-music`, and `/var/lib/media`. The options
  stay `services.media` and `programs.media`. Not `/run/media`, which udisks2 uses for mounts on
  desktops, and not a `media` user or group, which hosts often already have for their library
  files (the owner's NAS does).
- An upgrade from 0.3.0 or 0.4.0 keeps the state where it is. `dataDir` (`/var/lib/media`) has had
  a media name since 0.3.0 and collides with nothing, and moving it would risk the core's database
  for no gain. The files 0.3.0's and 0.4.0's `movies` user left there keep its ids once NixOS drops
  that user, so they are handed to the service user (below). The default transcode folder starts
  empty at its new path, and the module leaves `/var/cache/movies/transcode` alone, since
  [movies] v0.2 uses that path too.
- **Evaluation refuses overlapping folders.** Every folder the service owns (`dataDir`,
  `backupDir`, `transcodeDir`, and `/run/media-server`, `/run/media-account`, `/run/media-music`,
  and `/run/media-proxy`) must not be, hold, or sit inside a `libraryDirs` entry, or any of the old
  installs' folders: `/var/lib/movies`, `/var/cache/movies`, `/run/movies`, `/var/lib/music`, and
  the roots and libraries the host's `services.movies` and `services.music` set, when it imports
  those modules. The folders the service hands over (`dataDir/movies/media`, `backupDir`, and
  `transcodeDir`) must not be, hold, or sit inside the core's database (`dataDir/core/convex`) or
  its secrets (`dataDir/core/secrets`). Since the media service empties `transcodeDir` at every
  start, `transcodeDir` must not be, hold, or sit inside `backupDir` or `dataDir/movies/media`.
  `dataDir`, `backupDir`, `transcodeDir`, and every `libraryDirs` entry must be absolute and
  normalized (no `.`, `..`, `//`, or trailing `/`), as systemd ignores any other path in
  `BindPaths`, `ReadWritePaths`, and `InaccessiblePaths`. Symlinks resolve only on the host, below.
- **The handover is bounded.** A unit of its own, `media-server-handover`, runs before every start
  of the media service, which requires it:
  1. As root, outside any sandbox, it refuses to go on if a symlink is anywhere on the path of a
     folder it hands over (the resolved path differs from the configured one), or if a folder
     overlaps a library, another install's folder, or the core's database or secrets once both
     are resolved on disk. Then it makes the missing folders and gives each top folder to the
     service user. Nothing in this step is recursive. tmpfiles no longer makes these folders,
     since it would follow a symlink there before any check.
  2. In a sandbox, it walks the folders: each is a non-recursive bind of itself
     (`BindPaths=…:norbind`), so nothing mounted inside one is visible, a bind mount from the same
     disk included, which `find -xdev` alone would cross. The libraries, the old installs'
     folders, and the core's database and secrets are inaccessible, the rest of the system is
     read-only, and the walk keeps only `CAP_CHOWN` and `CAP_DAC_READ_SEARCH`. `find -xdev` never
     follows a symlink, and `chown -h` and `chgrp -h` change a symlink itself. Only files of an
     earlier owner change owner: the uid and gid the
     marker records, and the `movies` user's and group's ids, from `getent` or from NixOS's
     `/var/lib/nixos/uid-map` and `gid-map`, which keep a dropped user's ids. Anything else keeps
     its owner, and the log counts it.
  3. As root, once the walk succeeds, it records the service user's numeric uid and gid in
     `dataDir/core/service-owner`, a root-only file in a root-only folder. While it matches, later
     starts skip the walk. An interrupted walk records nothing, so the next start walks again,
     and a forged record can only point the walk at other files inside the service's own folders.

  The folders need not be under `/var/lib/media` and `/var/cache/media`, the defaults, since
  `dataDir`, `backupDir`, and `transcodeDir` may be set elsewhere. Instead each must resolve to its
  own configured path, which evaluation has checked.

- An upgrade that overrides `systemd.services.movies` or `users.users.movies`, such as
  `users.users.movies.extraGroups` for library access, moves the override to `media-server`. The
  release notes and `docs/operations.md` ("Upgrading") say so.

## Consequences

- `nix/vm-test.nix` checks the new names and the upgrade: with no record of the owner, as 0.4.0
  left it, and NixOS's record of the dropped `movies` ids, the next start hands the files of those
  ids to `media-server` with nothing lost, while a file of another uid keeps its owner. It also
  checks that a symlinked parent of the service's state stops the start before any chown, and
  that a bind mount inside it keeps its files' owner.
- The flake's `module-overlaps` check evaluates each refused overlap, including a library inside
  the data root and the old modules' own settings, and settings that overlap nothing.
- On a host that manages users without `/var/lib/nixos/uid-map` (systemd-sysusers, userborn), a
  dropped `movies` user's ids are unknown, so an upgrade from 0.3.0 or 0.4.0 leaves its files to
  that uid. The handover logs how many, and `chown` by hand finishes it.
- tmpfiles still makes root's own folders (`dataDir`, `dataDir/core`, its `convex` and `secrets`,
  and `dataDir/movies`), and would follow a symlink root put at one of those paths: a mode and
  owner change of its target, never recursive. The handover then refuses to start.
- The flake's `module-names` check fails when the module claims a unit, user, group, container,
  tmpfiles path, runtime folder, or data folder that [movies] v0.2's or old [music]'s module uses.
- `scripts/nixos-module-e2e.sh` refuses a host where a real install runs (any of `/run/media-server`,
  `/run/media-proxy`, `/run/media-account`, `/run/media-music`), or where Docker cannot say
  whether its container exists, and only then sets up its cleanup. The cleanup removes only what
  the run recorded as it made it: containers by the IDs `docker run` printed, never by name.
- Proven in `p8-install`: a NixOS guest imports [movies] v0.2's module and this one together, and
  both start and serve on their own ports.
- The image keeps its own paths inside the container (`/run/movies/media.env`, user `movies`);
  nothing outside the container sees them.
