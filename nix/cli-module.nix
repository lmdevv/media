# NixOS module for the `media` CLI. A host that runs services.media gets it already pointed at
# that server (nix/module.nix). Any other machine that talks to the same server imports just this
# module (`movies.nixosModules.cli`) and sets:
#
#   programs.media = {
#     enable = true;
#     convexUrl = "http://nas.tailnet.ts.net:3210";
#     mediaUrl = "http://nas.tailnet.ts.net:8080";
#   };
#
# Each user still runs `media auth login` once (or sets MEDIA_CORE_API_KEY), so no key enters the
# Nix store.
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
    environment = {
      systemPackages = [ cfg.package ];
      sessionVariables = shared.sessionVariables cfg;
    };
  };
}
