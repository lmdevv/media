# Home Manager module for the `media` CLI, on Linux or macOS:
#
#   programs.media = {
#     enable = true;
#     convexUrl = "http://nas.tailnet.ts.net:3210";
#     mediaUrl = "http://nas.tailnet.ts.net:8080";
#   };
#
# You still run `media login` once (or set MEDIA_API_KEY), so no key enters the Nix store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.media;

  shared = import ./cli-options.nix { inherit lib pkgs; };
in
{
  options.programs.media = shared.options;

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    home.sessionVariables = shared.sessionVariables cfg;
  };
}
