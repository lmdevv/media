{
  description = "[music]: self-hosted music for people and agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
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
            evaluate =
              music:
              nixpkgs.lib.nixosSystem {
                inherit system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "25.11";
                    services.music = {
                      enable = true;
                    }
                    // music;
                  }
                ];
              };
            failed =
              evaluated:
              map (check: check.message) (builtins.filter (check: !check.assertion) evaluated.config.assertions);
            container = evaluated: evaluated.config.virtualisation.oci-containers.containers.music;
            expect = condition: message: if condition then true else throw "module check: ${message}";

            # The list form mounts each folder at /music/<folder name>, as every earlier install did.
            listed = evaluate { musicDirs = [ "/srv/music" ]; };
            # The attrset form names each mount, so folders with the same name can coexist.
            named = evaluate {
              musicDirs = {
                rock = "/a/music";
                jazz = "/b/music";
              };
              pull = "newer";
            };
            # Two folders named `music` would both mount at /music/music.
            clashing = evaluate {
              musicDirs = [
                "/a/music"
                "/b/music"
              ];
            };
            # The container's Convex and Caddy ids, which init refuses at start.
            reservedUid = evaluate { uid = 901; };
            reservedGid = evaluate { gid = 902; };
            refusesReserved =
              evaluated:
              builtins.any (nixpkgs.lib.hasInfix "uid and gid cannot be 901 or 902") (failed evaluated);
          in
          assert expect (
            refusesReserved reservedUid && refusesReserved reservedGid
          ) "uid or gid 901/902 is not refused: ${toString (failed reservedUid)}";
          assert expect (failed listed == [ ]) "the list form fails: ${toString (failed listed)}";
          assert expect (
            (container listed).volumes == [
              "/var/lib/music:/data"
              "/srv/music:/music/music:ro"
            ]
          ) "the list form mounts ${builtins.toJSON (container listed).volumes}";
          assert expect (failed named == [ ]) "the attrset form fails: ${toString (failed named)}";
          assert expect (
            (container named).volumes == [
              "/var/lib/music:/data"
              "/b/music:/music/jazz:ro"
              "/a/music:/music/rock:ro"
            ]
          ) "the attrset form mounts ${builtins.toJSON (container named).volumes}";
          assert expect ((container named).pull == "newer") "pull is not passed through";
          assert expect (
            builtins.length (failed clashing) == 1
            && nixpkgs.lib.hasInfix "/a/music and /b/music would all mount at /music/music" (
              builtins.head (failed clashing)
            )
          ) "duplicate folder names are not refused: ${toString (failed clashing)}";
          nixpkgs.legacyPackages.${system}.writeText "music-module-check" (
            builtins.toJSON {
              inherit (container listed)
                image
                ports
                volumes
                environment
                pull
                ;
            }
          );
      });
    };
}
