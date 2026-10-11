{
  description = "[music]: self-hosted music for people and agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.ffmpeg
            pkgs.caddy
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      nixosModules.default = import ./nix/module.nix;

      # Evaluates the module in a minimal system so `nix flake check` catches option errors.
      checks = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        module =
          let
            evaluated = nixpkgs.lib.nixosSystem {
              inherit system;
              modules = [
                self.nixosModules.default
                {
                  boot.isContainer = true;
                  system.stateVersion = "25.11";
                  services.music = {
                    enable = true;
                    musicDirs = [ "/srv/music" ];
                  };
                }
              ];
            };
            container = evaluated.config.virtualisation.oci-containers.containers.music;
          in
          nixpkgs.legacyPackages.${system}.writeText "music-module-check" (
            builtins.toJSON {
              inherit (container)
                image
                ports
                volumes
                environment
                ;
            }
          );
      });
    };
}
