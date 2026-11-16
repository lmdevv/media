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
  for no gain. The first start as a new owner, as root and before the service runs, hands the
  service's own folders (`dataDir/movies/media`, `backupDir`, and `transcodeDir`) to the service
  user with `chown -R -P`, once: a root-only file, `dataDir/core/service-owner`, records whom they
  were last given to, since tmpfiles re-owns their top folders before any start. That covers the
  files the old `movies` user left, which keep its uid once NixOS drops the user, and a later change
  of `user` or `group`. The default transcode folder starts empty at its new path, and the module
  leaves `/var/cache/movies/transcode` alone, since [movies] v0.2 uses that path too.
- An upgrade that overrides `systemd.services.movies` or `users.users.movies`, such as
  `users.users.movies.extraGroups` for library access, moves the override to `media-server`. The
  release notes and `docs/operations.md` ("Upgrading") say so.

## Consequences

- `nix/vm-test.nix` checks the new names and the upgrade: with no record of the owner, as 0.4.0
  left it, it hands the service's folders to a uid no user has, as 0.4.0's `movies` files are after
  the upgrade, and checks that the next start hands them back with nothing lost.
- The flake's `module-names` check fails when the module claims a unit, user, group, container,
  tmpfiles path, runtime folder, or data folder that [movies] v0.2's or old [music]'s module uses.
- `scripts/nixos-module-e2e.sh` refuses a host where `/run/media-server` or `/run/media-account`
  exists, where a real install runs, and only then sets up the cleanup that removes containers.
- Proven in `p8-install`: a NixOS guest imports [movies] v0.2's module and this one together, and
  both start and serve on their own ports.
- The image keeps its own paths inside the container (`/run/movies/media.env`, user `movies`);
  nothing outside the container sees them.
