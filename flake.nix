{
  description = "[media]: self-hosted media for people and agents";

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
      linuxSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forLinux = f: nixpkgs.lib.genAttrs linuxSystems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            # ffmpeg-full carries libvpl (Intel QSV); the default ffmpeg does not.
            pkgs.ffmpeg-full
            pkgs.curl
            pkgs.unzip
            pkgs.dvdauthor
            pkgs.fontconfig
          ];
          FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs.stdenv.hostPlatform) isLinux;
          cli = pkgs.callPackage ./nix/cli.nix { };
          media = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit cli;
          default = if isLinux then media else cli;
        }
        // nixpkgs.lib.optionalAttrs isLinux { inherit media; }
      );

      apps = forAllSystems (
        pkgs:
        let
          media = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.cli;
            meta.description = "The [media] command line";
          };
        in
        {
          default = media;
          cli = media;
        }
      );

      overlays.default = final: _prev: {
        media = final.callPackage ./nix/package.nix { };
        media-cli = final.callPackage ./nix/cli.nix { };
      };

      # `cli` is a path, like the server module's own import of it, so a system can import both.
      nixosModules = {
        media = import ./nix/module.nix;
        default = self.nixosModules.media;
        cli = ./nix/cli-module.nix;
      };

      homeManagerModules = {
        media = ./nix/home-module.nix;
        default = self.homeManagerModules.media;
      };

      checks = forLinux (
        pkgs:
        let
          evaluate =
            settings:
            let
              evaluated = nixpkgs.lib.nixosSystem {
                inherit (pkgs.stdenv.hostPlatform) system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "26.05";
                    services.media = {
                      enable = true;
                      libraryDirs = [ "/srv/media/movies" ];
                    }
                    // settings;
                  }
                ];
              };
              inherit (evaluated) config;
              service = config.systemd.services.media-server;
            in
            pkgs.writeText "media-module-check" (
              builtins.toJSON {
                containers = builtins.mapAttrs (_: container: {
                  inherit (container)
                    image
                    ports
                    volumes
                    environment
                    ;
                }) config.virtualisation.oci-containers.containers;
                proxy = config.systemd.services.media-proxy.environment;
                inherit (service) environment serviceConfig;
                firewall = config.networking.firewall.allowedTCPPorts;
                groups = config.users.users.media-server.extraGroups;
              }
            );
        in
        {
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.media;
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) cli;
          module = evaluate { };
          module-qsv = evaluate {
            hardwareAcceleration = "qsv";
            openFirewall = true;
            tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
            environmentFile = "/run/secrets/media.env";
            otlpEndpoint = "http://127.0.0.1:4318";
            qsvDevice = "/dev/dri/renderD129";
            extraEnvironment.LIBVA_DRIVER_NAME = "iHD";
          };
          # The service writes in its folders and empties transcodeDir at every start, so evaluation
          # refuses any that overlaps a library or the core's database and secrets.
          module-overlaps =
            let
              inherit (nixpkgs) lib;
              refused =
                { settings, ... }:
                map (assertion: assertion.message) (
                  lib.filter (assertion: !assertion.assertion)
                    (nixpkgs.lib.nixosSystem {
                      inherit (pkgs.stdenv.hostPlatform) system;
                      modules = [
                        self.nixosModules.default
                        {
                          boot.isContainer = true;
                          system.stateVersion = "26.05";
                          services.media = {
                            enable = true;
                            libraryDirs = [ "/srv/media/movies" ];
                          }
                          // settings;
                        }
                      ];
                    }).config.assertions
                );
              refusals = {
                library-inside-data-root = {
                  settings.libraryDirs = [ "/var/lib/media/movies/media/library" ];
                  messagePart = "dataDir (/var/lib/media) and the library (/var/lib/media/movies/media/library)";
                };
                library-holding-data-root = {
                  settings.libraryDirs = [ "/var/lib" ];
                  messagePart = "dataDir (/var/lib/media) and the library (/var/lib)";
                };
                library-written-loosely = {
                  settings.libraryDirs = [ "/srv/media/../media/./movies/" ];
                  messagePart = "without `.`, `..`, `//`, or a trailing `/`: /srv/media/../media/./movies/";
                };
                data-root-written-loosely = {
                  settings.dataDir = "/var/lib//media";
                  messagePart = "without `.`, `..`, `//`, or a trailing `/`: /var/lib//media";
                };
                transcodes-inside-library = {
                  settings.transcodeDir = "/srv/media/movies/.transcode";
                  messagePart = "transcodeDir (/srv/media/movies/.transcode) and the library (/srv/media/movies)";
                };
                runtime-inside-library = {
                  settings.libraryDirs = [ "/run" ];
                  messagePart = "a runtime folder (/run/media-server) and the library (/run)";
                };
                backups-holding-database = {
                  settings.backupDir = "/var/lib/media/core";
                  messagePart = "backupDir (/var/lib/media/core) and the core's database (/var/lib/media/core/convex)";
                };
                transcodes-inside-database = {
                  settings.transcodeDir = "/var/lib/media/core/convex/transcode";
                  messagePart = "transcodeDir (/var/lib/media/core/convex/transcode) and the core's database (/var/lib/media/core/convex)";
                };
                backups-inside-secrets = {
                  settings.backupDir = "/var/lib/media/core/secrets/backups";
                  messagePart = "backupDir (/var/lib/media/core/secrets/backups) and the core's secrets (/var/lib/media/core/secrets)";
                };
                relative-library = {
                  settings.libraryDirs = [ "srv/media/movies" ];
                  messagePart = "without `.`, `..`, `//`, or a trailing `/`: srv/media/movies";
                };
                transcodes-holding-backups = {
                  settings.transcodeDir = "/var/lib/media/core";
                  messagePart = "transcodeDir (/var/lib/media/core) and backupDir (/var/lib/media/core/backups)";
                };
                transcodes-holding-state = {
                  settings.transcodeDir = "/var/lib/media/movies";
                  messagePart = "transcodeDir (/var/lib/media/movies) and dataDir/movies/media (/var/lib/media/movies/media)";
                };
                backups-inside-transcodes = {
                  settings = {
                    transcodeDir = "/mnt/fast/transcode";
                    backupDir = "/mnt/fast/transcode/backups";
                  };
                  messagePart = "transcodeDir (/mnt/fast/transcode) and backupDir (/mnt/fast/transcode/backups)";
                };
              };
              accepted = {
                defaults = { };
                shared-libraries = {
                  port = 8099;
                  dataDir = "/var/lib/media";
                  transcodeDir = "/var/cache/media/transcode";
                  libraryDirs = [
                    "/srv/shared/movies"
                    "/srv/shared/music"
                  ];
                };
                backups-elsewhere = {
                  backupDir = "/mnt/backups/media";
                  transcodeDir = "/mnt/fast/media-transcode";
                };
              };
              missed = lib.filterAttrs (
                _: refusal: !lib.any (lib.hasInfix refusal.messagePart) (refused refusal)
              ) refusals;
              wronglyRefused = lib.filterAttrs (_: messages: messages != [ ]) (
                lib.mapAttrs (_: settings: refused { inherit settings; }) accepted
              );
            in
            assert lib.assertMsg (
              missed == { }
            ) "services.media accepted overlapping folders: ${toString (builtins.attrNames missed)}";
            assert lib.assertMsg (
              wronglyRefused == { }
            ) "services.media refused folders that overlap nothing: ${builtins.toJSON wronglyRefused}";
            pkgs.writeText "media-module-overlaps-check" (builtins.toJSON (lib.mapAttrs (_: refused) refusals));
          module-vaapi = evaluate {
            hardwareAcceleration = "vaapi";
            vaapiDevice = "/dev/dri/renderD129";
            libraryWatch = "poll";
            libraryPollSeconds = 120;
          };
          cli-module =
            let
              system =
                modules: settings:
                (nixpkgs.lib.nixosSystem {
                  inherit (pkgs.stdenv.hostPlatform) system;
                  modules = modules ++ [
                    {
                      boot.isContainer = true;
                      system.stateVersion = "26.05";
                    }
                    settings
                  ];
                }).config;
              summary = config: {
                cli = builtins.any (package: package.pname or "" == "media-cli") config.environment.systemPackages;
                convexUrl = config.environment.sessionVariables.MEDIA_CORE_URL or null;
                mediaUrl = config.environment.sessionVariables.MEDIA_SERVER_URL or null;
                server = config.systemd.services ? media-server;
              };
              serverSettings.services.media = {
                enable = true;
                publicUrl = "http://nas:8080";
              };
              actual = {
                server = summary (system [ self.nixosModules.default ] serverSettings);
                cliOnly = summary (
                  system [ self.nixosModules.cli ] {
                    programs.media = {
                      enable = true;
                      convexUrl = "http://nas:3210";
                      mediaUrl = "http://nas:8080";
                    };
                  }
                );
                both = summary (
                  system [
                    self.nixosModules.default
                    self.nixosModules.cli
                  ] serverSettings
                );
                withoutCli = summary (
                  system [ self.nixosModules.default ] {
                    services.media.enable = true;
                    programs.media.enable = false;
                  }
                );
              };
              expected = {
                server = {
                  cli = true;
                  convexUrl = "http://nas:8080/convex";
                  mediaUrl = "http://nas:8080";
                  server = true;
                };
                cliOnly = {
                  cli = true;
                  convexUrl = "http://nas:3210";
                  mediaUrl = "http://nas:8080";
                  server = false;
                };
                both = expected.server;
                withoutCli = {
                  cli = false;
                  convexUrl = null;
                  mediaUrl = null;
                  server = true;
                };
              };
            in
            assert nixpkgs.lib.assertMsg (
              actual == expected
            ) "programs.media: expected ${builtins.toJSON expected}, got ${builtins.toJSON actual}";
            pkgs.writeText "media-cli-module-check" (builtins.toJSON actual);
          home-module =
            let
              inherit (nixpkgs) lib;
              home =
                settings:
                (lib.evalModules {
                  modules = [
                    self.homeManagerModules.media
                    {
                      options.home = {
                        packages = lib.mkOption {
                          type = lib.types.listOf lib.types.package;
                          default = [ ];
                        };
                        sessionVariables = lib.mkOption {
                          type = lib.types.lazyAttrsOf (
                            lib.types.oneOf [
                              lib.types.str
                              lib.types.path
                              lib.types.int
                              lib.types.float
                            ]
                          );
                          default = { };
                        };
                      };
                      config._module.args.pkgs = pkgs;
                    }
                    settings
                  ];
                }).config;
              summary = config: {
                cli = builtins.any (package: package.pname or "" == "media-cli") config.home.packages;
                inherit (config.home) sessionVariables;
              };
              actual = {
                configured = summary (home {
                  programs.media = {
                    enable = true;
                    convexUrl = "http://nas:3210";
                    mediaUrl = "http://nas:8080";
                  };
                });
                packageOnly = summary (home {
                  programs.media.enable = true;
                });
                off = summary (home { });
              };
              expected = {
                configured = {
                  cli = true;
                  sessionVariables = {
                    MEDIA_CORE_URL = "http://nas:3210";
                    MEDIA_SERVER_URL = "http://nas:8080";
                  };
                };
                packageOnly = {
                  cli = true;
                  sessionVariables = { };
                };
                off = {
                  cli = false;
                  sessionVariables = { };
                };
              };
            in
            assert lib.assertMsg (actual == expected)
              "Home Manager programs.media: expected ${builtins.toJSON expected}, got ${builtins.toJSON actual}";
            pkgs.writeText "media-home-module-check" (builtins.toJSON actual);
          vm = pkgs.callPackage ./nix/vm-test.nix { module = self.nixosModules.media; };
        }
      );
    };
}
