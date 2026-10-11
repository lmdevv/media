# NixOS module for [music]. Runs the all-in-one image with the host's container runtime.
#
#   services.music = {
#     enable = true;
#     publicUrl = "https://music.example.com";
#     musicDirs = [ "/srv/music" ];
#   };
#
# Each folder in musicDirs is mounted read-only at /music/<folder name>; add that path as a
# library in the web app. A native build with systemd units per service is planned.
{
  config,
  lib,
  ...
}:
let
  cfg = config.services.music;
in
{
  options.services.music = {
    enable = lib.mkEnableOption "[music], a self-hosted music server";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/lmdevv/music:main";
      description = "Container image to run.";
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
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/srv/music" ];
      description = ''
        Host folders mounted read-only at /music/<folder name>. The media service reads them as
        `uid`/`gid`, so their files must be readable by that user (world-readable 644 files and
        755 folders are).
      '';
    };

    uid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = ''
        User ID the media service runs as inside the container (PUID). It reads the music folders
        and owns the transcode cache and artwork in dataDir/media; it cannot read the secrets or
        the database.
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
    # Traversable, not listable: the media user reaches dataDir/media; everything else in
    # dataDir is root's alone.
    systemd.tmpfiles.rules = [ "d ${cfg.dataDir} 0711 root root -" ];

    virtualisation.oci-containers.containers.music = {
      inherit (cfg) image;
      ports = [ "${cfg.listenAddress}:${toString cfg.port}:8080" ];
      environment = {
        PUBLIC_URL = cfg.publicUrl;
        PUID = toString cfg.uid;
        PGID = toString cfg.gid;
      };
      volumes = [
        "${cfg.dataDir}:/data"
      ]
      ++ map (dir: "${dir}:/music/${baseNameOf dir}:ro") cfg.musicDirs;
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
