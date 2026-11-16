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
  that user, so the admin gives them to the service user with one `chown` (below). The default
  transcode folder starts empty at its new path, and the module leaves
  `/var/cache/movies/transcode` alone, since [movies] v0.2 uses that path too.
- **Evaluation refuses overlapping folders.** Every folder the service owns (`dataDir`,
  `backupDir`, `transcodeDir`, and `/run/media-server`, `/run/media-account`, `/run/media-music`,
  and `/run/media-proxy`) must not be, hold, or sit inside a `libraryDirs` entry, or any of the old
  installs' folders: `/var/lib/movies`, `/var/cache/movies`, `/run/movies`, `/var/lib/music`, and
  the roots and libraries the host's `services.movies` and `services.music` set, when it imports
  those modules. The folders the service user owns (`dataDir/movies/media`, `backupDir`, and
  `transcodeDir`) must not be, hold, or sit inside the core's database (`dataDir/core/convex`) or
  its secrets (`dataDir/core/secrets`). Since the media service empties `transcodeDir` at every
  start, `transcodeDir` must not be, hold, or sit inside `backupDir` or `dataDir/movies/media`.
  `dataDir`, `backupDir`, `transcodeDir`, and every `libraryDirs` entry must be absolute and
  normalized (no `.`, `..`, `//`, or trailing `/`), as systemd ignores any other path in
  `ReadWritePaths` and `ReadOnlyPaths`. Symlinks and mounts show only on the host, below.
- **The module never changes an owner it did not just create, and nothing it does is
  recursive.** Two rounds of verification each found a new way for a privileged walk over the
  service's folders to reach outside them: through a symlinked parent, a bind mount, a hard link,
  a tmpfiles rule that followed a symlinked `dataDir`, and a parent swapped between a check and a
  `mkdir`. The walk existed only to move files from 0.3.0's and 0.4.0's `movies` user to
  `media-server`, and only our CI and test guests ever ran those modules: the owner's NAS runs the
  old [movies] and [music] modules, so its `/var/lib/media` is new. So the walk is gone, with its
  record of the owner and its lookup of a dropped user's ids. One unit, `media-server-folders`,
  runs before every start of the media service and of the core's Convex container, which both
  require it:
  1. As root, it refuses to go on unless every folder on the way to `dataDir`, and root's own
     folders in it (`dataDir`, `dataDir/core`, its `convex` and `secrets`, and `dataDir/movies`),
     is a real folder, not a symlink, root's, and writable by no group or other user, so nothing
     on those paths can change between its checks and root's writes there. None of root's folders
     may be a mount point. Then it makes what is missing. It makes a missing folder of the
     service's only when every folder on the way to it is root's alone in the same sense, gives
     that new, empty folder to the service user, and changes the owner or mode of nothing that
     already existed.
  2. As the service user, so it can change nothing the service could not, it refuses to start
     unless each of the service's folders (`dataDir/movies/media`, `backupDir`, and
     `transcodeDir`) is a folder, not a symlink, with no symlink on its path, not a mount point,
     with nothing mounted inside it, and owned by the service user and group, and every folder
     above it is root's or the service user's and writable by no group or other user, so nobody
     else can swap it once the check has passed. When the top folder is the service user's, so
     is everything in it, and a file of another user with other names (a hard link) is refused by
     name, since it may be another file. A folder that is missing because root would not make it
     there, such as a `backupDir` inside the state folder, is made by the service user, with the
     folders missing on the way to it, each `0700`, when the nearest existing folder is
     the service user's. Otherwise the error names the `install -d` that makes it, listing every
     missing folder so none of them is left root's.

  For folders of another owner, and only when nothing else is wrong, the error names the one
  command that fixes them, and the old owner's uid. The admin first confirms that no process runs
  as that uid (`pgrep -u <uid>` prints nothing), then runs the exact line the check prints. After
  the 0.3.0 or 0.4.0 module, with the default folders, that is:

  ```sh
  sudo find /var/lib/media/core/backups /var/lib/media/movies/media -xdev \( -type d -o -links 1 \) -execdir chown -h media-server:media-server {} +
  ```

  with a custom `transcodeDir` or `backupDir` in place of the defaults when one is set. Then
  `systemctl start media-server`. It re-owns every folder and file in them except files with
  other names. `-execdir` runs `chown -h` from each entry's own folder, so a folder swapped for a
  symlink part way never redirects it. `-xdev` alone would not stop at a bind mount from the same
  file system, so the check refuses a folder with a mount at or inside it first, and prints no
  command for it. Nothing outside them changes, not even a library file hard-linked into one.

- No tmpfiles rule makes anything under `dataDir`, since tmpfiles follows a symlink on the way
  before anything checks it. Setup's upgrade backup is written and renamed by the service user,
  since root writes in no folder of `dataDir` that another user can change. Root still writes in
  `/run/media-server`, which systemd makes new at every start.
- systemd's `StateDirectory=` and `CacheDirectory=` were considered and rejected. systemd 261
  (`setup_exec_directory` in `src/core/exec-invoke.c`, `path_chown_recursive` in
  `src/shared/chown-recursive.c`) re-owns the whole tree whenever the top folder's owner differs
  from `User=`, a static user included. Its walk pins each entry with `O_PATH|O_NOFOLLOW`, so it
  never follows a symlink inside the tree, but it re-owns every entry rather than only an earlier
  owner's, descends into mounts, changes a hard-linked inode, drops ACLs, chmods the top folder,
  makes parents and opens the top folder following symlinks (`mkdir_parents_label`,
  `AT_SYMLINK_FOLLOW`), and covers only paths under `/var/lib` and `/var/cache`. That is the
  first three of the escapes above, recursive. `RuntimeDirectory=media-server` stays: systemd
  makes it new under `/run`, which only root can change, at every start.
- An upgrade that overrides `systemd.services.movies` or `users.users.movies`, such as
  `users.users.movies.extraGroups` for library access, moves the override to `media-server`. The
  release notes and `docs/operations.md` ("Upgrading") say so.

## Consequences

- `nix/vm-test.nix` checks the new names, the folders the module makes with their owners and
  modes, and that no tmpfiles rule touches them. An install from 0.4.0, whose folders belong to
  the old ids, refuses to start and names the command that fixes it; the test runs that exact
  line, and the next start keeps the data and the service key. Each of the verifier's escapes
  either refuses to start or changes nothing outside [media]'s folders, by inode, owner, mode, and
  link count: a library file hard-linked into the state folder (through the printed fix too, and
  the next start names the link), the library mounted at the state folder, at
  `transcodeDir`, at `dataDir/movies`, or inside the state folder, a symlinked `dataDir` in front
  of another install's database (the Convex container does not start either), a symlink on the
  way to the state folder, and another user swapping `transcodeDir` for a symlink to the library
  while the service starts, or owning its parent once the admin has made it.
- The flake's `module-overlaps` check evaluates each refused overlap, including a library inside
  the data root and the old modules' own settings, and settings that overlap nothing.
- An admin who upgrades from the 0.3.0 or 0.4.0 module runs one command once. A `dataDir`,
  `backupDir`, or `transcodeDir` that is itself a mount point, or that sits under a folder another
  user can change, is refused; point it at a folder inside the mounted disk instead. A file of
  another user in the service's folders, such as a backup restored as root, stops the start until
  it is given to the service user, as the restore steps already say.
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
