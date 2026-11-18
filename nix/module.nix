# NixOS module for [media]: the core's self-hosted Convex backend as a pinned OCI container, the
# media service (which also serves the movies client) as a native, hardened systemd service built
# from this repository (nix/package.nix), and Caddy in front of them on one address, with the
# image's routes (deploy/image/rootfs/etc/caddy/Caddyfile, docs/decisions/0015).
#
# Every unit, user, and folder it makes has a media name (media-server, media-proxy,
# media-core-convex, /var/lib/media, /var/cache/media, /run/media-server).
#
#   services.media = {
#     enable = true;
#     libraryDirs = [ "/srv/media/movies" "/srv/media/shows" ];
#     # Reached over Tailscale; see README.md.
#     listenAddress = "100.64.0.1";
#     publicUrl = "http://nas.tailnet.ts.net:8080";
#     hardwareAcceleration = "qsv";
#     tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
#     omdbApiKeyFile = "/run/secrets/omdb-api-key";
#   };
#
# Every startup derives the core's admin key from its backend's instance secret, backs up before
# an upgrade, deploys the core's functions, configures the deployment (keys and secrets are
# generated inside Convex and kept there) and both web clients, and writes the service's
# environment to /run/media-server/media.env, readable by the service user only. The first
# startup also creates the media service's service principal on the core and issues its key,
# which later startups reuse from a root-only file. No secret enters the Nix store.
#
# The host also gets the `media` CLI, pointed at this server (programs.media, in cli-module.nix).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.media;

  pinnedConvexImage = lib.fileContents ../deploy/convex-backend.image;

  backend = config.virtualisation.oci-containers.backend;
  containerRuntime = lib.getExe pkgs.${backend};
  containerUnits = [ "${backend}-media-core-convex.service" ];

  hardware = cfg.hardwareAcceleration != "none";
  ports = cfg.internalPorts;
  publicUrl = lib.removeSuffix "/" cfg.publicUrl;
  coreConvexUrl = "http://127.0.0.1:${toString ports.coreConvex}";
  coreDataDir = "${cfg.dataDir}/core";
  secretsDir = "${coreDataDir}/secrets";
  moviesDataDir = "${cfg.dataDir}/movies";
  mediaDataDir = "${moviesDataDir}/media";
  convexDataDir = "${coreDataDir}/convex";
  # Root's folders. Parents first, so each is made with its own mode rather than as a folder on
  # the way to another. The core's database and secrets stay root's, and setup writes its records
  # beside them as root.
  rootDirs = [
    {
      path = cfg.dataDir;
      mode = "0711";
    }
    {
      path = coreDataDir;
      mode = "0711";
    }
    {
      path = convexDataDir;
      mode = "0700";
    }
    {
      path = secretsDir;
      mode = "0700";
    }
    {
      path = moviesDataDir;
      mode = "0711";
    }
  ];

  libraries = lib.unique (map toString cfg.libraryDirs);
  # A path's components, with `.`, `..`, and repeated slashes resolved as far as evaluation can.
  # Symlinks and mounts show only on the host, where media-server-folders refuses them.
  components =
    path:
    lib.foldl' (
      parts: part:
      if part == "" || part == "." then
        parts
      else if part == ".." then
        (if parts == [ ] then [ ] else lib.init parts)
      else
        parts ++ [ part ]
    ) [ ] (lib.splitString "/" (toString path));
  # Whether one path is the other or holds it.
  overlap =
    a: b:
    lib.lists.hasPrefix (components a) (components b)
    || lib.lists.hasPrefix (components b) (components a);
  overlaps =
    folders: others:
    lib.concatMap (
      folder:
      map (other: "${folder.name} (${toString folder.path}) and ${other.name} (${toString other.path})") (
        lib.filter (other: overlap folder.path other.path) others
      )
    ) folders;
  named = name: paths: map (path: { inherit name path; }) paths;

  ownedFolders = [
    {
      name = "dataDir";
      path = cfg.dataDir;
    }
    {
      name = "backupDir";
      path = cfg.backupDir;
    }
    {
      name = "transcodeDir";
      path = cfg.transcodeDir;
    }
  ]
  ++ named "a runtime folder" [
    "/run/media-server"
    "/run/media-account"
    "/run/media-music"
    "/run/media-proxy"
  ];
  serviceFolders = [
    {
      name = "dataDir/movies/media";
      path = mediaDataDir;
    }
    {
      name = "backupDir";
      path = cfg.backupDir;
    }
    {
      name = "transcodeDir";
      path = cfg.transcodeDir;
    }
  ];
  # Sorted, so the check reaches a folder before any service folder inside it, which only the
  # service user may make.
  serviceDirs = lib.sort lib.lessThan (map (folder: folder.path) serviceFolders);
  libraryClashes = overlaps ownedFolders (named "the library" libraries);
  coreClashes = overlaps serviceFolders (
    named "the core's database" [ convexDataDir ] ++ named "the core's secrets" [ secretsDir ]
  );
  # The media service empties transcodeDir at every start.
  transcodeClashes = overlaps [
    {
      name = "transcodeDir";
      path = cfg.transcodeDir;
    }
  ] (lib.filter (folder: folder.name != "transcodeDir") serviceFolders);
  # systemd ignores a path in ReadWritePaths or ReadOnlyPaths that is not absolute and normalized,
  # which would leave a library writable or a folder unwritable, and media-server-folders compares
  # each path as written with where it resolves.
  normalized = path: toString path == "/" + lib.concatStringsSep "/" (components path);
  unnormalized = lib.filter (path: !normalized path) (
    [
      cfg.dataDir
      cfg.backupDir
      cfg.transcodeDir
    ]
    ++ cfg.libraryDirs
  );

  # A missing folder is made only below folders that are root's alone, so no other user can redirect
  # it between the check and the mkdir, and only a folder made here is given to the service user.
  # Nothing that already exists changes owner or mode, and nothing here is recursive.
  foldersPrepare = pkgs.writeShellApplication {
    name = "media-server-folders-prepare";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.util-linux
    ];
    text = ''
      log() { echo "media-server-folders: $*" >&2; }
      refuse() { log "refusing to start: $*"; exit 1; }

      # Once every folder on a path is root_only, nothing on it can change between a check and its use.
      root_only() {
        local owner mode
        [ -d "$1" ] && [ ! -L "$1" ] || return 1
        read -r owner mode < <(stat -c '%u %a' -- "$1")
        [ "$owner" = 0 ] && [ $((8#$mode & 8#022)) = 0 ]
      }
      # Says why $1 is not root_only.
      why_not_root_only() {
        local owner mode
        if [ -L "$1" ]; then
          echo "is a symlink to $(readlink -- "$1")"
        elif [ ! -d "$1" ]; then
          echo "is not a folder"
        else
          read -r owner mode < <(stat -c '%u %a' -- "$1")
          if [ "$owner" != 0 ]; then echo "belongs to uid $owner"; else echo "is writable by its group or others (mode $mode)"; fi
        fi
      }
      # Prints the first existing folder on the way to $1, $1 itself left out, that is not root's alone.
      unsafe_parent() {
        local path="" part
        local -a parts
        IFS=/ read -ra parts <<<"''${1#/}"
        unset 'parts[-1]'
        root_only / || { echo /; return 0; }
        for part in "''${parts[@]}"; do
          path+="/$part"
          [ -e "$path" ] || [ -L "$path" ] || return 0
          root_only "$path" || { echo "$path"; return 0; }
        done
      }
      # Makes $1 with mode $2, and the folders missing on the way to it, root's and 0755.
      make_dir() {
        local path="" part
        local -a parts
        IFS=/ read -ra parts <<<"''${1#/}"
        for part in "''${parts[@]}"; do
          path+="/$part"
          { [ -e "$path" ] || [ -L "$path" ]; } && continue
          if [ "$path" = "$1" ]; then mkdir -m "$2" -- "$path"; else mkdir -m 755 -- "$path"; fi
        done
      }

      root_dirs=(${lib.escapeShellArgs (map (dir: dir.path) rootDirs)})
      root_modes=(${lib.escapeShellArgs (map (dir: dir.mode) rootDirs)})
      for i in "''${!root_dirs[@]}"; do
        dir="''${root_dirs[i]}"
        parent="$(unsafe_parent "$dir")"
        [ -z "$parent" ] || refuse "$parent, on the way to $dir, $(why_not_root_only "$parent"), and root writes in $dir; keep dataDir in folders only root can change"
        if [ -L "$dir" ]; then
          refuse "$dir is a symlink to $(readlink -- "$dir"); set dataDir to a path without symlinks"
        elif [ -e "$dir" ]; then
          root_only "$dir" || refuse "$dir must be a folder of root's that only root can write, and it is $(stat -c '%F, uid %u, mode %a' -- "$dir")"
          ! mountpoint -q -- "$dir" || refuse "$dir is a mount point; set dataDir to a folder inside the mounted file system"
        else
          make_dir "$dir" "''${root_modes[i]}"
        fi
      done

      service_uid="$(id -u -- ${lib.escapeShellArg cfg.user})"
      for dir in ${lib.escapeShellArgs serviceDirs}; do
        { [ -e "$dir" ] || [ -L "$dir" ]; } && continue
        parent="$(unsafe_parent "$dir")"
        if [ -n "$parent" ] && [ -d "$parent" ] && [ ! -L "$parent" ] &&
          [ "$(stat -c %u -- "$parent")" = "$service_uid" ]; then
          log "leaving $dir to ${cfg.user} to make: $parent, on the way to it, is ${cfg.user}'s"
          continue
        elif [ -n "$parent" ]; then
          log "not making $dir: $parent, on the way to it, $(why_not_root_only "$parent")"
          continue
        fi
        make_dir "$dir" 700
        chown -h -- ${lib.escapeShellArg "${cfg.user}:${cfg.group}"} "$dir"
      done
    '';
  };

  # The module re-owns nothing that already exists; for a folder that is not the service user's,
  # this prints the command that would fix it.
  foldersCheck = pkgs.writeShellApplication {
    name = "media-server-folders-check";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.util-linux
    ];
    text = ''
      log() { echo "media-server-folders: $*" >&2; }
      user=${lib.escapeShellArg cfg.user}
      group=${lib.escapeShellArg cfg.group}
      uid="$(id -u)"
      gid="$(id -g)"
      problems=()
      foreign=()
      # findmnt escapes unusual characters as \xHH, which printf's %b reads back.
      mounts=()
      while IFS= read -r target; do mounts+=("$(printf '%b' "$target")"); done < <(findmnt -rn -o TARGET)

      # Only root and the service user may be able to change a folder above one of the service's:
      # anyone else could swap the folder for a symlink once this check has passed.
      ours_or_roots() {
        local owner mode
        read -r owner mode < <(stat -c '%u %a' -- "$1")
        { [ "$owner" = 0 ] || [ "$owner" = "$uid" ]; } && [ $((8#$mode & 8#022)) = 0 ]
      }
      # Says why $1, on the way to $2, fails that, and what to do.
      why_unsafe() {
        local owner mode keep="keep $2 in folders only root and $user can change"
        if [ -L "$1" ]; then
          echo "is a symlink to $(readlink -- "$1"); set the option to a path without symlinks"
          return 0
        fi
        read -r owner mode < <(stat -c '%u %a' -- "$1")
        if [ "$owner" != 0 ] && [ "$owner" != "$uid" ]; then
          echo "belongs to uid $owner; $keep"
        else
          echo "is writable by its group or others (mode $mode); $keep"
        fi
      }
      # Prints the first existing folder on the way to $1, $1 itself left out, that fails that.
      unsafe_parent() {
        local path="" part
        local -a parts
        IFS=/ read -ra parts <<<"''${1#/}"
        unset 'parts[-1]'
        { [ ! -L / ] && ours_or_roots /; } || { echo /; return 0; }
        for part in "''${parts[@]}"; do
          path+="/$part"
          [ -e "$path" ] || [ -L "$path" ] || return 0
          { [ ! -L "$path" ] && ours_or_roots "$path"; } || { echo "$path"; return 0; }
        done
      }
      # Prints the folders missing on the way to $1, $1 included, outermost first.
      missing_dirs() {
        local path="$1"
        local -a missing=()
        while [ ! -e "$path" ] && [ ! -L "$path" ]; do
          missing=("$path" "''${missing[@]}")
          path="$(dirname -- "$path")"
        done
        printf '%s\n' "''${missing[@]}"
      }
      # Makes each of its arguments, outermost first, 0700. The unit's system call filter allows no
      # chown or chgrp: a folder that takes a setgid parent's group fails the owner check below.
      make_dirs() {
        local dir
        for dir in "$@"; do mkdir -m 700 -- "$dir" || return 1; done
      }

      for dir in ${lib.escapeShellArgs serviceDirs}; do
        parent="$(unsafe_parent "$dir")"
        if [ -n "$parent" ]; then
          problems+=("$parent, on the way to $dir, $(why_unsafe "$parent" "$dir")")
          continue
        fi
        if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
          # Root makes none inside a folder of the service user's, such as a backupDir inside the
          # state folder; the service user does, with any folders missing on the way, once the
          # folders before it check out. Only root and the service user can change those, so none
          # becomes a symlink before mkdir.
          mapfile -t missing < <(missing_dirs "$dir")
          base="$(dirname -- "''${missing[0]}")"
          if [ "''${#problems[@]}" -gt 0 ] || [ "''${#foreign[@]}" -gt 0 ] ||
            [ ! -d "$base" ] || [ -L "$base" ] || [ "$(stat -c %u -- "$base")" != "$uid" ] ||
            ! make_dirs "''${missing[@]}"; then
            # Every missing folder is named, so install makes none of them root's.
            printf -v remedy ' %q' "''${missing[@]}"
            problems+=("$dir is missing; make it with: sudo install -d -m 700 -o $user -g $group$remedy")
            continue
          fi
        fi
        if [ -L "$dir" ]; then
          problems+=("$dir is a symlink to $(readlink -- "$dir"); set the option to a plain folder")
          continue
        fi
        if [ ! -d "$dir" ]; then
          problems+=("$dir is not a folder")
          continue
        fi
        if ! real="$(realpath -e -- "$dir" 2>/dev/null)"; then
          problems+=("$user cannot reach $dir")
          continue
        fi
        if [ "$real" != "$dir" ]; then
          problems+=("a symlink on the path of $dir leads to $real; set the option to a path without symlinks")
          continue
        fi
        for mount in "''${mounts[@]}"; do
          if [ "$mount" = "$dir" ]; then
            problems+=("$dir is a mount point; mount the file system above it and keep $dir a plain folder inside")
          elif [[ "$mount" == "$dir"/* ]]; then
            problems+=("$mount is mounted inside $dir")
          fi
        done
        read -r owner_uid owner_gid < <(stat -c '%u %g' -- "$dir")
        if [ "$owner_uid" != "$uid" ] || [ "$owner_gid" != "$gid" ]; then
          log "$dir belongs to uid $owner_uid and gid $owner_gid, not $user:$group"
          foreign+=("$dir")
          continue
        fi
        # Another user's file with other names may be someone else's file: the fix below skips it.
        linked="$(find "$dir" -xdev ! -type d -links +1 \( ! -uid "$uid" -o ! -gid "$gid" \) -print -quit 2>/dev/null || true)"
        if [ -n "$linked" ]; then
          problems+=("$linked, in $dir, is another user's and has other names (hard links), so it may be another file; remove this name, or give it to $user yourself if it is [media]'s")
          continue
        fi
        other="$(find "$dir" -xdev \( ! -uid "$uid" -o ! -gid "$gid" \) -print -quit 2>/dev/null || true)"
        if [ -n "$other" ]; then
          log "$other, in $dir, belongs to $(stat -c 'uid %u and gid %g' -- "$other"), not $user:$group"
          foreign+=("$dir")
        fi
      done

      for problem in "''${problems[@]}"; do log "refusing to start: $problem"; done
      [ "''${#problems[@]}" -eq 0 ] || exit 1
      if [ "''${#foreign[@]}" -gt 0 ]; then
        command="sudo find"
        for dir in "''${foreign[@]}"; do printf -v command '%s %q' "$command" "$dir"; done
        # The other owners' uids, root's left out: a process of theirs could swap a file for a
        # symlink while the fix runs.
        uids="$({ find "''${foreign[@]}" -xdev ! -uid 0 ! -uid "$uid" -printf '%U\n' 2>/dev/null || true; } | sort -nu | paste -sd , -)"
        printf -v command '%s -xdev \\( -type d -o -links 1 \\) -execdir chown -h %q {} +' "$command" "$user:$group"
        log "refusing to start: the service's folders and what is in them must be $user's, and the module re-owns nothing that already exists"
        [ -z "$uids" ] || log "first check that no process runs as uid $uids: pgrep -u $uids must print nothing"
        log "give them to $user, all but files with other names (hard links):"
        log "$command"
        log "then start it again: sudo systemctl start media-server"
        exit 1
      fi
    '';
  };

  # The instance secret's file inside the Convex container, on its data volume, where
  # `convex-entry.sh` keeps it.
  convexSecretFile = "/convex/data/credentials/instance_secret";

  # Its HTTP actions stay inside its container (docs/decisions/0025).
  convexContainer = name: port: origin: dataDir: {
    image = cfg.convexImage;
    entrypoint = "/bin/bash";
    cmd = [ "/media-convex-entry.sh" ];
    ports = [ "127.0.0.1:${toString port}:3210" ];
    environment = {
      INSTANCE_NAME = name;
      CONVEX_CLOUD_ORIGIN = origin;
      CONVEX_SITE_ORIGIN = "http://127.0.0.1:3211";
      # Idle memory, as in the image (docs/decisions/0027).
      MALLOC_ARENA_MAX = "2";
      ISOLATE_IDLE_TIMEOUT_SECONDS = "60";
    };
    volumes = [
      "${dataDir}:/convex/data"
      "${./convex-entry.sh}:/media-convex-entry.sh:ro"
      "${cfg.package}/lib/media/convex/argv-secret.so:/argv-secret.so:ro"
    ];
  };

  setup = pkgs.writeShellApplication {
    name = "media-server-setup";
    runtimeInputs = [
      cfg.package
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
      pkgs.util-linux
    ];
    text = ''
      umask 077
      log() { echo "media-server-setup: $*" >&2; }
      # Outside CI the Convex CLI reports to Sentry, and where that host is slow or blocked each
      # command waits minutes for it on exit. A self-hosted install sends nothing anyway.
      export CI=1
      # `convex deploy` also asks version.convex.dev for news, with no timeout. A refused loopback
      # port fails that fetch at once, so a start never waits on the internet.
      export CONVEX_VERSION_API_ORIGIN=http://127.0.0.1:9

      public_url=${lib.escapeShellArg publicUrl}
      as_service() {
        setpriv --reuid=${lib.escapeShellArg cfg.user} --regid=${lib.escapeShellArg cfg.group} --clear-groups -- "$@"
      }

      url=${lib.escapeShellArg coreConvexUrl}
      data=${lib.escapeShellArg coreDataDir}
      backups=${lib.escapeShellArg cfg.backupDir}
      version=${lib.escapeShellArg cfg.package.version}
      hash_file=${lib.escapeShellArg "${cfg.package}/lib/media/platform/.functions-hash"}
      [ -s "$hash_file" ] && version="$version+$(cat "$hash_file")"

      log "waiting for the core's Convex backend at $url"
      for _ in $(seq 1 120); do
        curl -fsS "$url/version" >/dev/null 2>&1 && break
        sleep 1
      done
      curl -fsS "$url/version" >/dev/null

      # `generate_key` takes the secret only as an argument; the shim reads it from its file.
      admin_key="$(${containerRuntime} exec -e LD_PRELOAD=/argv-secret.so \
        -e ARGV_SECRET_FILE=${convexSecretFile} media-core-convex \
        /convex/generate_key core @ARGV_SECRET_FILE | tail -n 1)"
      export CONVEX_SELF_HOSTED_URL="$url" CONVEX_SELF_HOSTED_ADMIN_KEY="$admin_key"

      if [ -s "$data/version" ] && [ "$(cat "$data/version")" != "$version" ] &&
        [ "$(cat "$data/upgrade-backup" 2>/dev/null)" != "$version" ]; then
        name="core-manual-$(date -u +%Y-%m-%dT%H-%M-%S-000Z).zip"
        log "upgrading the core from $(cat "$data/version") to $version; backing up to $name first"
        # As the service user, which owns the backups and takes the nightly ones: root writes nothing
        # in a folder another user can change.
        as_service media-core-convex export --include-file-storage --path "$backups/.partial-$name"
        as_service mv -T -- "$backups/.partial-$name" "$backups/$name"
        printf '%s\n' "$version" >"$data/upgrade-backup"
      fi

      log "deploying the core's functions ($version)"
      media-core-convex deploy --yes --codegen disable --typecheck disable
      log "configuring the core deployment"
      media-core-configure
      printf '%s\n' "$version" >"$data/version"
      rm -f "$data/upgrade-backup"

      # The media service signs in to the core as its own service principal, created on the first
      # startup. Its key is shown once, so it is kept in a root-only file that later startups
      # reuse; without the file, the principal gets a new key, and its first use retires the old
      # ones. The key goes from the CLI's output to the file, never to a command line or the log.
      service_id_file=${lib.escapeShellArg "${secretsDir}/media-service-id"}
      service_key_file=${lib.escapeShellArg "${secretsDir}/media-service-key"}
      create_service() {
        log "creating the media server's service principal"
        media-core-convex run core/accounts/host:createService '{"name":"media server"}' |
          jq -er . >"$service_id_file.partial"
        mv "$service_id_file.partial" "$service_id_file"
      }
      issue_service_key() {
        media-core-convex run core/auth/apiKeys:issueServiceKey \
          "$(jq -cn --arg id "$(cat "$service_id_file")" '{serviceId: $id}')" |
          jq -er .key >"$service_key_file.partial"
      }
      if ! [ -s "$service_key_file" ]; then
        [ -s "$service_id_file" ] || create_service
        log "issuing the media server's service key"
        # A restored database may not hold the recorded principal; then the server gets a new one.
        if ! issue_service_key; then
          create_service
          issue_service_key
        fi
        mv "$service_key_file.partial" "$service_key_file"
      fi
      media_ticket_keys="$(media-core-convex env get MEDIA_TICKET_KEYS)"
      [ -n "$media_ticket_keys" ] || { log "the core deployment has no MEDIA_TICKET_KEYS"; exit 1; }

      umask 022
      media-configure-account --to /run/media-account --convex-url "$public_url/convex"
      media-configure-music --to /run/media-music --convex-url "$public_url/convex"
      media-configure-movies --to /run/media-server/web --convex-url "$public_url/convex"

      umask 077
      env_file=/run/media-server/media.env
      install -m 600 -o ${lib.escapeShellArg cfg.user} -g ${lib.escapeShellArg cfg.group} /dev/null "$env_file"
      {
        printf 'MEDIA_SERVICE_API_KEY=%s\n' "$(cat "$service_key_file")"
        printf 'MEDIA_TICKET_KEYS=%s\n' "$media_ticket_keys"
        printf 'CONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$admin_key"
        ${lib.optionalString (cfg.tmdbApiKeyFile != null) ''
          printf 'TMDB_API_KEY=%s\n' "$(cat ${lib.escapeShellArg cfg.tmdbApiKeyFile})"
        ''}
        ${lib.optionalString (cfg.omdbApiKeyFile != null) ''
          printf 'OMDB_API_KEY=%s\n' "$(cat ${lib.escapeShellArg cfg.omdbApiKeyFile})"
        ''}
      } >>"$env_file"
    '';
  };
in
{
  imports = [
    ./cli-module.nix
  ];

  options.services.media = {
    enable = lib.mkEnableOption "[media], self-hosted media for people and agents";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = ''
        The [media] package: media service, web clients, and the core's Convex project. Set it to
        the flake's own build, `inputs.media.packages.''${system}.media`, to use the nixpkgs it was
        tested with. The flake's overlay names it `pkgs.media`.
      '';
    };

    ffmpegPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.ffmpeg-full;
      defaultText = lib.literalExpression "pkgs.ffmpeg-full";
      description = "ffmpeg and ffprobe. ffmpeg-full is built with libvpl, which Quick Sync needs.";
    };

    libraryDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/srv/media/movies"
        "/mnt/nas/shows"
      ];
      description = ''
        Folders the media service may scan and stream, read-only. Add each one as a library in the
        web app. The service user must be able to read them (world-readable files and folders are),
        or put it in a group that can through `users.users.media-server.extraGroups`.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/media";
      description = ''
        State, one folder per domain: the core's Convex database (`core/convex/`), the media
        service's key (`core/secrets/`), and the media service's caches (`movies/media/`). An
        install from before the movies cutover also keeps old movies' database (`movies/convex/`).
        A plain folder: no symlink on its path, not a mount point (use a folder inside the mounted
        file system), and only root may be able to change the folders above it.
      '';
    };

    backupDir = lib.mkOption {
      type = lib.types.path;
      default = "${cfg.dataDir}/core/backups";
      defaultText = lib.literalExpression ''"''${config.services.media.dataDir}/core/backups"'';
      description = ''
        Nightly backups of the core's database (Convex exports with file storage). A plain folder of
        the service user's: no symlink on its path, not a mount point, and only root or the service
        user may be able to change the folders above it.
      '';
    };

    backupRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Backups older than this are removed after a new backup succeeds.";
    };

    transcodeDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/cache/media/transcode";
      description = ''
        Disposable HLS segments. Put it on fast storage with a few GB free, as a folder inside the
        mounted file system rather than its mount point: like backupDir, a plain folder of the
        service user's.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "The one port of the whole product: both web clients, Convex, the API, and streams.";
    };

    trustedProxies = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "127.0.0.1/32" ];
      description = ''
        CIDRs of proxies in front of [media] whose `X-Forwarded-For` names the client, such as a TLS
        proxy on this host (`127.0.0.1/32`). The media service limits unauthenticated routes per
        client, so without this every request through such a proxy counts as one client.
      '';
    };

    internalPorts = {
      coreConvex = lib.mkOption {
        type = lib.types.port;
        default = 3210;
        description = "Loopback port of the core's Convex backend, which Caddy serves at /convex.";
      };

      media = lib.mkOption {
        type = lib.types.port;
        default = 4300;
        description = "Loopback port of the media service, behind Caddy.";
      };
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Listen on all interfaces and open the port in the firewall.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = if cfg.openFirewall then "0.0.0.0" else "127.0.0.1";
      defaultText = lib.literalExpression ''if config.services.media.openFirewall then "0.0.0.0" else "127.0.0.1"'';
      example = "100.64.0.1";
      description = ''
        Address the port listens on. The default keeps [media] local; set the host's Tailscale
        address to reach it over the tailnet only. The Convex backend and the media service listen
        on loopback only.
      '';
    };

    publicUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://localhost:${toString cfg.port}";
      defaultText = lib.literalExpression ''"http://localhost:''${toString config.services.media.port}"'';
      description = ''
        URL people use for [media]: the account client at its root, movies at `/movies`, music at
        `/music`, and the core's Convex backend (`/convex`) and streams under it.
      '';
    };

    hardwareAcceleration = lib.mkOption {
      type = lib.types.enum [
        "auto"
        "qsv"
        "vaapi"
        "none"
      ];
      default = "auto";
      description = ''
        GPU transcoding. `auto` gives the service the render nodes and probes Quick Sync, then
        VA-API, falling back to software encoding; `qsv` also enables the host's Intel media driver
        and oneVPL runtime (Gen12+, Tiger Lake and newer); `vaapi` enables the host's graphics stack
        with the Intel media driver (AMD's VA-API driver comes with Mesa) for GPUs whose ffmpeg
        lacks Quick Sync; `none` keeps the service away from the GPU.
      '';
    };

    vaapiDevice = lib.mkOption {
      type = lib.types.str;
      default = "/dev/dri/renderD128";
      example = "/dev/dri/renderD129";
      description = "DRM render node used for VA-API, for hosts with more than one GPU.";
    };

    qsvDevice = lib.mkOption {
      type = lib.types.str;
      default = "/dev/dri/renderD128";
      example = "/dev/dri/renderD129";
      description = "DRM render node used for Quick Sync, for hosts with more than one GPU.";
    };

    maxConcurrentTranscodes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 3;
      description = "Upper bound on simultaneous video transcodes.";
    };

    maxConcurrentRemuxes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10;
      description = "Upper bound on simultaneous HLS streams that copy the video (remux, audio-only).";
    };

    streamIdleSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = ''
        A stream's encoder stops, freeing its transcode slot and segments, after this long with
        no requests and no playing progress. The stream stays, and its next request restarts
        the encoder. With no playback session reports, as in standalone mode, a stream closes
        once its encoder has been stopped and unused for ten times this.
      '';
    };

    streamBufferAheadSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 120;
      description = ''
        How far a stream's ffmpeg may run ahead of the player before it pauses; it continues once
        the player is within half of this.
      '';
    };

    minFreeTranscodeMb = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2048;
      description = "Free space `transcodeDir` must keep, in MiB, before a new stream starts.";
    };

    libraryReconcileMinutes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 360;
      description = "Interval of the full library reconciliation that backs up file watching.";
    };

    trickplay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Make scrub thumbnails (sprite sheets the player shows over the seek bar) for new and
          changed files, in the background at the lowest CPU priority.
        '';
      };

      intervalSeconds = lib.mkOption {
        type = lib.types.ints.between 1 600;
        default = 10;
        description = "Seconds between scrub thumbnails.";
      };

      concurrency = lib.mkOption {
        type = lib.types.ints.positive;
        default = 1;
        description = "Files given scrub thumbnails at once, besides scans and other jobs.";
      };
    };

    libraryWatch = lib.mkOption {
      type = lib.types.enum [
        "auto"
        "events"
        "poll"
      ];
      default = "auto";
      description = ''
        How libraries notice changes. `auto` uses file system events on local disks and polls
        network file systems (NFS, SMB/CIFS, 9p, sshfs and other FUSE mounts), which send none;
        `events` and `poll` force one way for every library.
      '';
    };

    libraryPollSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = "How often polled library folders are checked for changes.";
    };

    probeTimeoutSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = "Longest an ffprobe probe, artwork resize, or other short tool run may take.";
    };

    fileScanTimeoutSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 900;
      description = ''
        Longest a tool run that reads a whole file may take: a keyframe scan, or extracting an
        embedded subtitle track. Raise it for very large files on slow network shares.
      '';
    };

    cacheMaxMb = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2048;
      description = ''
        Size in MiB the media service's caches (provider responses, keyframe indexes, subtitles,
        artwork, music's cached transcodes) are pruned to, least recently used first.
      '';
    };

    logLevel = lib.mkOption {
      type = lib.types.enum [
        "trace"
        "debug"
        "info"
        "warn"
        "error"
      ];
      default = "info";
      description = ''
        Least severe level the media service logs, to the journal and to its retained log files
        under `dataDir/media/logs`, which `media logs` reads.
      '';
    };

    logRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Days the media service keeps its retained log files.";
    };

    logMaxMb = lib.mkOption {
      type = lib.types.ints.between 8 1048576;
      default = 512;
      description = ''
        Size in MiB the retained log files never grow past together. Each file holds at most an
        eighth of it (64 MiB at most), and the oldest go before a write would pass it.
      '';
    };

    tmdbApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/tmdb-api-key";
      description = ''
        File holding a TMDB v3 API key or v4 read access token, for metadata and artwork. Read at
        startup by root; keep it out of the Nix store (agenix, sops-nix, or a root-only file).
      '';
    };

    omdbApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/omdb-api-key";
      description = ''
        File holding an OMDb API key, for IMDb, Rotten Tomatoes, and Metacritic scores; without it
        titles show TMDB's score only. Read at startup by root; keep it out of the Nix store.
      '';
    };

    otlpEndpoint = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:4318";
      description = "OTLP/HTTP collector for traces and logs. Nothing is exported without it.";
    };

    lrclibUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:8090";
      description = ''
        Where music looks up lyrics, for a stand-in; LRCLIB itself (https://lrclib.net) when
        null. An admin turns lookups off in the account client.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/media.env";
      description = ''
        Extra `KEY=value` lines for the media service, read by systemd as root: secrets such as
        `TMDB_API_KEY`, kept out of the Nix store (agenix, sops-nix, or a root-only file; give a
        string, since a path literal is copied into the store). Lines here override every other
        setting, options and `extraEnvironment` included, except the generated Convex credentials,
        so keep it to secrets.
      '';
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        LIBVA_DRIVER_NAME = "iHD";
      };
      description = ''
        More environment variables for the media service, for settings without an option here
        (see apps/media/README.md). They override the options' values. Values land in the Nix
        store: use `environmentFile` for secrets.
      '';
    };

    convexImage = lib.mkOption {
      type = lib.types.str;
      default = pinnedConvexImage;
      description = ''
        Convex backend image. The default is the version this release is tested with
        (deploy/convex-backend.image); change it only to mirror that image.
      '';
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "media-server";
      description = ''
        User the media service runs as. The module creates `media-server`; set another user to
        declare it yourself.
      '';
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "media-server";
      description = ''
        Group the media service runs as. The module creates `media-server`; set another group to
        declare it yourself.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # The service writes in its folders and empties transcodeDir at every start, so none may be,
    # hold, or sit inside a library or, for the folders its user owns, the core's database or
    # secrets.
    assertions = [
      {
        assertion = unnormalized == [ ];
        message = ''
          services.media: dataDir, backupDir, transcodeDir, and libraryDirs take absolute paths
          without `.`, `..`, `//`, or a trailing `/`: ${toString unnormalized}
        '';
      }
      {
        assertion = libraryClashes == [ ];
        message = ''
          services.media: a folder the service owns overlaps a library, which must stay read-only:
          ${lib.concatStringsSep "\n" libraryClashes}
          Keep dataDir, backupDir, and transcodeDir apart from every libraryDirs entry.
        '';
      }
      {
        assertion = coreClashes == [ ];
        message = ''
          services.media: a folder the service owns overlaps the core's database or secrets, which
          stay root's:
          ${lib.concatStringsSep "\n" coreClashes}
          Keep backupDir and transcodeDir out of dataDir/core/convex and dataDir/core/secrets, and
          neither may hold them.
        '';
      }
      {
        assertion = transcodeClashes == [ ];
        message = ''
          services.media: the media service empties transcodeDir at every start, and it overlaps
          ${lib.concatStringsSep "\n" transcodeClashes}
          Give transcodeDir a folder of its own.
        '';
      }
    ];

    programs.media = {
      enable = lib.mkDefault true;
      convexUrl = lib.mkDefault "${publicUrl}/convex";
      mediaUrl = lib.mkDefault cfg.publicUrl;
    };

    users.users = lib.mkIf (cfg.user == "media-server") {
      media-server = {
        isSystemUser = true;
        inherit (cfg) group;
        extraGroups = lib.optionals hardware [
          "render"
          "video"
        ];
      };
    };
    users.groups = lib.mkIf (cfg.group == "media-server") { media-server = { }; };

    hardware.graphics =
      lib.mkIf (cfg.hardwareAcceleration == "qsv" || cfg.hardwareAcceleration == "vaapi")
        {
          enable = true;
          extraPackages = [
            pkgs.intel-media-driver
          ]
          ++ lib.optionals (cfg.hardwareAcceleration == "qsv") [ pkgs.vpl-gpu-rt ];
        };

    virtualisation.oci-containers.containers = {
      media-core-convex =
        convexContainer "core" ports.coreConvex "${publicUrl}/convex"
          "${coreDataDir}/convex";
    };

    systemd.services.media-proxy = {
      description = "[media] on one address";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        MEDIA_BIND = cfg.listenAddress;
        MEDIA_PORT = toString cfg.port;
        MEDIA_CORE_CONVEX = "127.0.0.1:${toString ports.coreConvex}";
        MEDIA_SERVICE = "127.0.0.1:${toString ports.media}";
        MEDIA_ACCOUNT_DIR = "/run/media-account";
        MEDIA_MUSIC_DIR = "/run/media-music";
        MEDIA_TRUSTED_PROXIES = lib.concatStringsSep " " cfg.trustedProxies;
        HOME = "/run/media-proxy";
        XDG_CONFIG_HOME = "/run/media-proxy/config";
        XDG_DATA_HOME = "/run/media-proxy/data";
      };
      serviceConfig = {
        ExecStart = "${lib.getExe pkgs.caddy} run --config ${cfg.package}/lib/media/Caddyfile --adapter caddyfile";
        Restart = "on-failure";
        RestartSec = 5;
        DynamicUser = true;
        RuntimeDirectory = "media-proxy";
        AmbientCapabilities = lib.optionals (cfg.port < 1024) [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = lib.optionals (cfg.port < 1024) [ "CAP_NET_BIND_SERVICE" ];
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
      };
    };

    # Before every start of the media service and the core's container. No tmpfiles rule makes these
    # folders: tmpfiles follows a symlink on the way before anything checks it (ADR 0029).
    systemd.services.media-server-folders = {
      description = "[media] folders checked before it starts";
      serviceConfig = {
        Type = "oneshot";
        User = cfg.user;
        Group = cfg.group;
        ExecStartPre = "+${lib.getExe foldersPrepare}";
        ExecStart = lib.getExe foldersCheck;
        # No file system namespace, so the check sees the host's mounts; as the service user it
        # can change nothing beyond what the service itself may.
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        RestrictAddressFamilies = [ "AF_UNIX" ];
        IPAddressDeny = "any";
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        UMask = "0077";
      };
    };
    # The container's database is in dataDir/core/convex, which the check above must pass first.
    systemd.services."${backend}-media-core-convex" = {
      requires = [ "media-server-folders.service" ];
      after = [ "media-server-folders.service" ];
    };

    systemd.services.media-server = {
      description = "[media] media service";
      wantedBy = [ "multi-user.target" ];
      requires = containerUnits ++ [ "media-server-folders.service" ];
      after = containerUnits ++ [
        "media-server-folders.service"
        "network-online.target"
      ];
      wants = [ "network-online.target" ];
      # setpriv starts every ffmpeg with a parent-death signal, so none outlives the service. The
      # default KillMode (control-group) also stops anything left when the service exits.
      path = [ pkgs.util-linux ];

      environment = {
        NODE_ENV = "production";
        HOST = "127.0.0.1";
        PORT = toString ports.media;
        MEDIA_BASE_URL = publicUrl;
        CONVEX_URL = coreConvexUrl;
        CONVEX_PUBLIC_URL = "${publicUrl}/convex";
        CONVEX_BACKEND_DIR = "${cfg.package}/lib/media/platform";
        DATA_DIR = mediaDataDir;
        BACKUP_DIR = cfg.backupDir;
        BACKUP_RETENTION_DAYS = toString cfg.backupRetentionDays;
        TRANSCODE_DIR = cfg.transcodeDir;
        WEB_DIST_DIR = "/run/media-server/web";
        LIBRARY_ROOTS = lib.concatStringsSep "," cfg.libraryDirs;
        HARDWARE_ACCELERATION = cfg.hardwareAcceleration;
        QSV_DEVICE = cfg.qsvDevice;
        VAAPI_DEVICE = cfg.vaapiDevice;
        MAX_CONCURRENT_TRANSCODES = toString cfg.maxConcurrentTranscodes;
        MAX_CONCURRENT_REMUXES = toString cfg.maxConcurrentRemuxes;
        STREAM_IDLE_SECONDS = toString cfg.streamIdleSeconds;
        STREAM_BUFFER_AHEAD_SECONDS = toString cfg.streamBufferAheadSeconds;
        MIN_FREE_TRANSCODE_MB = toString cfg.minFreeTranscodeMb;
        LIBRARY_RECONCILE_MINUTES = toString cfg.libraryReconcileMinutes;
        TRICKPLAY = if cfg.trickplay.enable then "on" else "off";
        TRICKPLAY_INTERVAL_SECONDS = toString cfg.trickplay.intervalSeconds;
        TRICKPLAY_CONCURRENCY = toString cfg.trickplay.concurrency;
        LIBRARY_WATCH = cfg.libraryWatch;
        LIBRARY_POLL_SECONDS = toString cfg.libraryPollSeconds;
        PROBE_TIMEOUT_SECONDS = toString cfg.probeTimeoutSeconds;
        FILE_SCAN_TIMEOUT_SECONDS = toString cfg.fileScanTimeoutSeconds;
        CACHE_MAX_MB = toString cfg.cacheMaxMb;
        LOG_LEVEL = cfg.logLevel;
        LOG_RETENTION_DAYS = toString cfg.logRetentionDays;
        LOG_MAX_MB = toString cfg.logMaxMb;
        FFMPEG_PATH = lib.getExe' cfg.ffmpegPackage "ffmpeg";
        FFPROBE_PATH = lib.getExe' cfg.ffmpegPackage "ffprobe";
      }
      // lib.optionalAttrs (cfg.otlpEndpoint != null) {
        OTEL_EXPORTER_OTLP_ENDPOINT = cfg.otlpEndpoint;
      }
      // lib.optionalAttrs (cfg.lrclibUrl != null) {
        LRCLIB_URL = cfg.lrclibUrl;
      }
      // lib.optionalAttrs hardware {
        # NixOS keeps VA-API drivers and the oneVPL runtime here (hardware.graphics).
        LIBVA_DRIVERS_PATH = "/run/opengl-driver/lib/dri";
        ONEVPL_SEARCH_PATH = "/run/opengl-driver/lib";
      }
      // cfg.extraEnvironment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        # Root and unsandboxed: reaches the container runtime, deploys, writes the environment.
        ExecStartPre = "+${lib.getExe setup}";
        # media.env is written by ExecStartPre and read before ExecStart, so it is optional only
        # for the setup. Later files win, so the generated credentials override environmentFile.
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile ++ [
          "-/run/media-server/media.env"
        ];
        ExecStart = lib.getExe' cfg.package "media-server";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStartSec = "10min";
        RuntimeDirectory = "media-server";
        RuntimeDirectoryMode = "0755";

        ReadWritePaths = [
          mediaDataDir
          cfg.backupDir
          cfg.transcodeDir
        ];
        ReadOnlyPaths = cfg.libraryDirs;
        UMask = "0077";
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        PrivateTmp = true;
        PrivateDevices = !hardware;
        DevicePolicy = "closed";
        # The render nodes (/dev/dri/renderD*) are DRM character devices.
        DeviceAllow = lib.optionals hardware [ "char-drm rw" ];
        SupplementaryGroups = lib.optionals hardware [
          "render"
          "video"
        ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        # V8 compiles JavaScript to executable memory.
        MemoryDenyWriteExecute = false;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
          # setpriv, which gives each ffmpeg its parent-death signal, also re-applies the process's
          # capabilities. With no capabilities to keep, that grants nothing.
          "capset"
        ];
        # A denied call fails that call rather than killing the service and every stream with it.
        # scripts/check-sandbox.sh still kills on one, so the service is kept from needing any.
        SystemCallErrorNumber = "EPERM";
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
