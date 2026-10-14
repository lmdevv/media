# NixOS module for [music]. Runs the all-in-one image with the host's container runtime.
#
#   services.music = {
#     enable = true;
#     publicUrl = "https://music.example.com";
#     musicDirs = [ "/srv/music" ];
#   };
#
# Each folder in musicDirs is mounted read-only at /music/<folder name>; add that path as a
# library in the web app. Two folders with the same name need the attrset form, which names each
# mount: musicDirs = { rock = "/a/music"; jazz = "/b/music"; } mounts /music/rock and /music/jazz.
# A native build with systemd units per service is planned.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.music;

  # { name, path } for each folder: the list form names a mount after the folder, which is how
  # every install before the attrset form named them, so existing libraries keep their paths.
  mounts =
    if builtins.isList cfg.musicDirs then
      map (path: {
        name = baseNameOf path;
        inherit path;
      }) cfg.musicDirs
    else
      lib.mapAttrsToList (name: path: { inherit name path; }) cfg.musicDirs;

  byName = lib.groupBy (mount: mount.name) mounts;

  clashes = lib.filterAttrs (_: group: builtins.length group > 1) byName;

  describeClash =
    name: group:
    "${lib.concatMapStringsSep " and " (mount: mount.path) group} would all mount at /music/${name}";

  invalidNames = builtins.filter (
    mount:
    builtins.elem mount.name [
      ""
      "."
      ".."
    ]
    || lib.hasInfix "/" mount.name
    || lib.hasInfix ":" mount.name
  ) mounts;

  # The ids of the container's Convex and Caddy users (deploy/docker/Dockerfile).
  reservedIds = [
    901
    902
  ];

  # The runtime reads `host:container:ro`, so a host path needs a leading / and no colon.
  badPaths = builtins.filter (
    mount: !lib.hasPrefix "/" mount.path || lib.hasInfix ":" mount.path
  ) mounts;
in
{
  options.services.music = {
    enable = lib.mkEnableOption "[music], a self-hosted music server";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/lmdevv/music:main";
      description = "Container image to run.";
    };

    pull = lib.mkOption {
      type = lib.types.enum [
        "always"
        "missing"
        "never"
        "newer"
      ];
      default = "missing";
      description = ''
        When the container runtime pulls `image` as the service starts. The default, `missing`,
        pulls it once and then keeps running that copy, so a mutable tag such as `main` or
        `latest` never updates on its own. Pin a version tag and change it to upgrade, or set
        `newer` (or `always`) to fetch the tag's current image on every service start.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Host port for the web app, API, and streams.";
    };

    publicUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://localhost:${toString cfg.port}";
      defaultText = lib.literalExpression ''"http://localhost:''${toString config.services.music.port}"'';
      description = "URL people use to reach the server.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/music";
      description = "Database, artwork, transcode cache, secrets, and backups.";
    };

    musicDirs = lib.mkOption {
      type = with lib.types; either (listOf str) (attrsOf str);
      default = [ ];
      example = lib.literalExpression ''{ rock = "/srv/rock/music"; jazz = "/mnt/jazz/music"; }'';
      description = ''
        Host folders mounted read-only for the library. A list mounts each folder at
        /music/<folder name>; two folders with the same name would collide, so name the mounts
        with an attrset instead: `{ rock = "/a/music"; }` mounts /a/music at /music/rock. Libraries
        store these in-container paths, so keep a mount's name once a library uses it. The media
        service reads the folders as `uid`/`gid`, so their files must be readable by that user
        (world-readable 644 files and 755 folders are).
      '';
    };

    uid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = ''
        User ID the media service runs as inside the container (PUID). It reads the music folders
        and owns the transcode cache and artwork in dataDir/media; it cannot read the secrets or
        the database. 901 and 902 are taken by the container's Convex and Caddy users.
      '';
    };

    gid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = "Group ID the media service runs as inside the container (PGID).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the port in the firewall and listen on all interfaces.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = if cfg.openFirewall then "0.0.0.0" else "127.0.0.1";
      defaultText = lib.literalExpression ''if config.services.music.openFirewall then "0.0.0.0" else "127.0.0.1"'';
      description = ''
        Host address the port is published on. Container port publishing bypasses the NixOS
        firewall, so this, not the firewall, decides who can connect. The default keeps the
        server local (for a reverse proxy or Tailscale serve) unless openFirewall is set.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = clashes == { };
        message = ''
          services.music.musicDirs: ${lib.concatStringsSep "; " (lib.mapAttrsToList describeClash clashes)}.
          Name each mount with the attrset form instead, for example
            musicDirs = { rock = "/a/music"; jazz = "/b/music"; };
          which mounts them at /music/rock and /music/jazz. A library that already uses
          /music/<name> keeps working if that folder keeps its name.
        '';
      }
      {
        assertion = invalidNames == [ ];
        message = "services.music.musicDirs: ${
          lib.concatMapStringsSep ", " (mount: ''"${mount.name}" (${mount.path})'') invalidNames
        } cannot name a mount under /music; use a plain folder name without / or :.";
      }
      {
        assertion = badPaths == [ ];
        message = "services.music.musicDirs: ${
          lib.concatMapStringsSep ", " (mount: mount.path) badPaths
        } must be absolute paths without a colon.";
      }
      {
        # The container's init refuses these at start, which would crash-loop the service.
        assertion = !(builtins.elem cfg.uid reservedIds || builtins.elem cfg.gid reservedIds);
        message = "services.music.uid and gid cannot be 901 or 902 (got uid ${toString cfg.uid}, gid ${toString cfg.gid}): the container's Convex and Caddy users have those ids, and sharing one would let the media service read the database.";
      }
    ];

    # Traversable, not listable: the media user reaches dataDir/media; everything else in
    # dataDir is root's alone.
    systemd.tmpfiles.rules = [ "d ${cfg.dataDir} 0711 root root -" ];

    virtualisation.oci-containers.containers.music = {
      inherit (cfg) image pull;
      ports = [ "${cfg.listenAddress}:${toString cfg.port}:8080" ];
      environment = {
        PUBLIC_URL = cfg.publicUrl;
        PUID = toString cfg.uid;
        PGID = toString cfg.gid;
      };
      volumes = [
        "${cfg.dataDir}:/data"
      ]
      ++ map (mount: "${mount.path}:/music/${mount.name}:ro") mounts;
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
