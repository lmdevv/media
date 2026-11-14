# NixOS module for [media]: the core's self-hosted Convex backend as a pinned OCI container, the
# media service (which also serves the movies client) as a native, hardened systemd service built
# from this repository (nix/package.nix), and Caddy in front of them on one address, with the
# image's routes (deploy/image/rootfs/etc/caddy/Caddyfile, docs/decisions/0015).
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
# environment to /run/movies/media.env, readable by the service user only. The first startup also
# creates the media service's service principal on the core and issues its key, which later
# startups reuse from a root-only file. No secret enters the Nix store.
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
      "${cfg.package}/lib/movies/convex/argv-secret.so:/argv-secret.so:ro"
    ];
  };

  setup = pkgs.writeShellApplication {
    name = "movies-setup";
    runtimeInputs = [
      cfg.package
      pkgs.coreutils
      pkgs.curl
      pkgs.findutils
      pkgs.jq
    ];
    text = ''
      umask 077
      log() { echo "movies-setup: $*" >&2; }
      # Outside CI the Convex CLI reports to Sentry, and where that host is slow or blocked each
      # command waits minutes for it on exit. A self-hosted install sends nothing anyway.
      export CI=1
      # `convex deploy` also asks version.convex.dev for news, with no timeout. A refused loopback
      # port fails that fetch at once, so a start never waits on the internet.
      export CONVEX_VERSION_API_ORIGIN=http://127.0.0.1:9

      public_url=${lib.escapeShellArg publicUrl}
      owner=${lib.escapeShellArg "${cfg.user}:${cfg.group}"}

      # The service's folders, in case they were removed since boot (tmpfiles creates them). The
      # core's backups are the service's: it takes the nightly ones and restores them.
      install -d -m 700 -o ${lib.escapeShellArg cfg.user} -g ${lib.escapeShellArg cfg.group} \
        ${lib.escapeShellArgs [
          mediaDataDir
          cfg.backupDir
          cfg.transcodeDir
        ]}
      find ${lib.escapeShellArg cfg.backupDir} \( \! -user ${lib.escapeShellArg cfg.user} -o \! -group ${lib.escapeShellArg cfg.group} \) \
        -exec chown -h "$owner" {} +
      install -d -m 700 ${lib.escapeShellArg secretsDir}

      url=${lib.escapeShellArg coreConvexUrl}
      data=${lib.escapeShellArg coreDataDir}
      backups=${lib.escapeShellArg cfg.backupDir}
      version=${lib.escapeShellArg cfg.package.version}
      hash_file=${lib.escapeShellArg "${cfg.package}/lib/movies/platform/.functions-hash"}
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
        media-core-convex export --include-file-storage --path "$backups/.partial-$name"
        mv "$backups/.partial-$name" "$backups/$name"
        chown "$owner" "$backups/$name"
        printf '%s\n' "$version" >"$data/upgrade-backup"
      fi

      log "deploying the core's functions ($version)"
      media-core-convex deploy --yes --codegen disable --typecheck disable
      log "configuring the core deployment"
      media-core-configure
      media-core-convex run core/schemaMigrations:run >/dev/null
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
      movies-configure-account --to /run/media-account --convex-url "$public_url/convex"
      movies-configure-web --to /run/movies/web --convex-url "$public_url/convex"

      umask 077
      env_file=/run/movies/media.env
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
    (lib.mkRemovedOptionModule [ "services" "media" "internalPorts" "moviesConvex" ] ''
      Movies moved into the core's Convex backend, which serves at /convex on internalPorts.coreConvex.
    '')
  ];

  options.services.media = {
    enable = lib.mkEnableOption "[media], self-hosted media for people and agents";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = ''
        The [media] package: media service, web clients, and the core's Convex project. Set it to `pkgs.movies`
        to use the flake's overlay (or your override of it).
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
        or put it in a group that can through `users.users.movies.extraGroups`.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/media";
      description = ''
        State, one folder per domain: the core's Convex database (`core/convex/`), the media
        service's key (`core/secrets/`), and the media service's caches (`movies/media/`). An
        install from before the movies cutover also keeps old movies' database (`movies/convex/`).
      '';
    };

    backupDir = lib.mkOption {
      type = lib.types.path;
      default = "${cfg.dataDir}/core/backups";
      defaultText = lib.literalExpression ''"''${config.services.media.dataDir}/core/backups"'';
      description = "Nightly backups of the core's database (Convex exports with file storage).";
    };

    backupRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Backups older than this are removed after a new backup succeeds.";
    };

    transcodeDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/cache/movies/transcode";
      description = "Disposable HLS segments. Put it on fast storage with a few GB free.";
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
        URL people use for [media]: the account client at its root, movies at `/movies`, and the
        core's Convex backend (`/convex`) and streams under it.
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
      example = "/run/secrets/movies.env";
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
      default = "movies";
      description = "User the media service runs as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "movies";
      description = "Group the media service runs as.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.media = {
      enable = lib.mkDefault true;
      convexUrl = lib.mkDefault "${publicUrl}/convex";
      mediaUrl = lib.mkDefault cfg.publicUrl;
    };

    users.users = lib.mkIf (cfg.user == "movies") {
      movies = {
        isSystemUser = true;
        inherit (cfg) group;
        extraGroups = lib.optionals hardware [
          "render"
          "video"
        ];
      };
    };
    users.groups = lib.mkIf (cfg.group == "movies") { movies = { }; };

    hardware.graphics =
      lib.mkIf (cfg.hardwareAcceleration == "qsv" || cfg.hardwareAcceleration == "vaapi")
        {
          enable = true;
          extraPackages = [
            pkgs.intel-media-driver
          ]
          ++ lib.optionals (cfg.hardwareAcceleration == "qsv") [ pkgs.vpl-gpu-rt ];
        };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0711 root root -"
      "d ${coreDataDir} 0711 root root -"
      "d ${coreDataDir}/convex 0700 root root -"
      "d ${secretsDir} 0700 root root -"
      "d ${moviesDataDir} 0711 root root -"
      "d ${mediaDataDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.backupDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.transcodeDir} 0700 ${cfg.user} ${cfg.group} -"
    ];

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
        MEDIA_TRUSTED_PROXIES = lib.concatStringsSep " " cfg.trustedProxies;
        HOME = "/run/media-proxy";
        XDG_CONFIG_HOME = "/run/media-proxy/config";
        XDG_DATA_HOME = "/run/media-proxy/data";
      };
      serviceConfig = {
        ExecStart = "${lib.getExe pkgs.caddy} run --config ${cfg.package}/lib/movies/Caddyfile --adapter caddyfile";
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

    systemd.services.movies = {
      description = "[media] media service";
      wantedBy = [ "multi-user.target" ];
      requires = containerUnits;
      after = containerUnits ++ [ "network-online.target" ];
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
        CONVEX_BACKEND_DIR = "${cfg.package}/lib/movies/platform";
        DATA_DIR = mediaDataDir;
        BACKUP_DIR = cfg.backupDir;
        BACKUP_RETENTION_DAYS = toString cfg.backupRetentionDays;
        TRANSCODE_DIR = cfg.transcodeDir;
        WEB_DIST_DIR = "/run/movies/web";
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
          "-/run/movies/media.env"
        ];
        ExecStart = lib.getExe' cfg.package "movies-media";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStartSec = "10min";
        RuntimeDirectory = "movies";
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
