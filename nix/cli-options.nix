{ lib, pkgs }:
{
  options = {
    enable = lib.mkEnableOption "the [movies] command line";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./cli.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./cli.nix { }";
      description = ''
        The `media` CLI package, built with your nixpkgs. On a nixpkgs too old to build it, use
        the flake's own: `movies.packages.''${pkgs.stdenv.hostPlatform.system}.cli`.
      '';
    };

    convexUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:3210";
      description = ''
        The server's core URL, set as `MEDIA_CORE_URL`, so `media auth login` needs no
        `--server`. A profile saved for another server stays unused while it is set.
      '';
    };

    mediaUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://nas.tailnet.ts.net:8080";
      description = ''
        The media server's URL, set as `MEDIA_SERVER_URL`: where the CLI streams, reads logs,
        and signs in.
      '';
    };
  };

  sessionVariables =
    cfg:
    lib.optionalAttrs (cfg.convexUrl != null) { MEDIA_CORE_URL = cfg.convexUrl; }
    // lib.optionalAttrs (cfg.mediaUrl != null) { MEDIA_SERVER_URL = cfg.mediaUrl; };
}
