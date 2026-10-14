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

      packages = forAllSystems (pkgs: rec {
        cli = pkgs.callPackage ./nix/cli.nix { };
        default = cli;
      });

      # `nix run github:lmdevv/music#cli -- whoami`
      apps = forAllSystems (
        pkgs:
        let
          music = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.cli;
            meta.description = "The [music] command line";
          };
        in
        {
          default = music;
          cli = music;
        }
      );

      nixosModules.default = import ./nix/module.nix;

      # Evaluates the module in a minimal system so `nix flake check` catches option errors.
      checks = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
        system:
        {
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
              # Docker, extra variables, and the update timer.
              tuned = evaluate {
                backend = "docker";
                image = "ghcr.io/lmdevv/music:latest";
                autoUpdate.enable = true;
                extraEnvironment = {
                  TZ = "Europe/Berlin";
                  PUID = "5";
                };
              };
              # A host that already runs its oci-containers with Docker, as earlier versions allowed.
              inherited = nixpkgs.lib.nixosSystem {
                inherit system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "25.11";
                    virtualisation.oci-containers.backend = "docker";
                    services.music.enable = true;
                  }
                ];
              };
              inherit (nixpkgs.lib.importJSON ./package.json) version;
              # Every workspace package (apps/* and packages/*, the CLI included) and its version.
              workspaceVersions =
                nixpkgs.lib.concatMap
                  (
                    group:
                    nixpkgs.lib.mapAttrsToList (package: _: {
                      path = "${group}/${package}/package.json";
                      inherit (nixpkgs.lib.importJSON (./. + "/${group}/${package}/package.json")) version;
                    }) (nixpkgs.lib.filterAttrs (_: type: type == "directory") (builtins.readDir (./. + "/${group}")))
                  )
                  [
                    "apps"
                    "packages"
                  ];
              strayVersions = builtins.filter (package: package.version != version) workspaceVersions;
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
            # One release version everywhere: the image is published under it, the image and the CLI
            # report it, and the module's default image is derived from it.
            assert expect (builtins.length workspaceVersions >= 9 && strayVersions == [ ])
              "package.json is ${version} but ${
                nixpkgs.lib.concatMapStringsSep ", " (
                  package: "${package.path} is ${package.version}"
                ) strayVersions
              }; bump them together";
            assert expect (
              (container listed).image == "ghcr.io/lmdevv/music:${version}"
            ) "the default image is ${(container listed).image}";
            assert expect (
              listed.config.virtualisation.oci-containers.backend == "podman"
            ) "podman is not the default backend";
            assert expect (failed tuned == [ ]) "the tuned config fails: ${toString (failed tuned)}";
            assert expect (
              tuned.config.virtualisation.oci-containers.backend == "docker"
              && (container tuned).serviceName == "docker-music"
            ) "the docker backend is not used";
            assert expect (
              (container tuned).environment.TZ == "Europe/Berlin" && (container tuned).environment.PUID == "1000"
            ) "extraEnvironment is not merged under the module's settings";
            assert expect (
              tuned.config.systemd.timers ? music-update
              && nixpkgs.lib.hasInfix "docker-music.service" tuned.config.systemd.services.music-update.script
            ) "autoUpdate does not restart the right service";
            assert expect (
              failed inherited == [ ]
              && (container inherited).serviceName == "docker-music"
              && nixpkgs.lib.hasInfix "docker pull" (
                (evaluate {
                  backend = "docker";
                  autoUpdate.enable = true;
                }).config.systemd.services.music-update.script
              )
            ) "an existing Docker host does not keep its backend: ${toString (failed inherited)}";
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

          # Builds the CLI, so a stale pnpm dependency hash fails `nix flake check`.
          inherit (self.packages.${system}) cli;
        }
        # A VM booting the module with a real image. Needs KVM, which CI has.
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          vm = import ./nix/vm-test.nix {
            pkgs = nixpkgs.legacyPackages.${system};
            module = self.nixosModules.default;
          };
        }
      );
    };
}
