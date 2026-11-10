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
          movies = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit cli;
          default = if isLinux then movies else cli;
        }
        // nixpkgs.lib.optionalAttrs isLinux { inherit movies; }
      );

      apps = forAllSystems (
        pkgs:
        let
          movies = {
            type = "app";
            program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.cli;
            meta.description = "The [movies] command line";
          };
        in
        {
          default = movies;
          cli = movies;
        }
      );

      overlays.default = final: _prev: {
        movies = final.callPackage ./nix/package.nix { };
        movies-cli = final.callPackage ./nix/cli.nix { };
      };

      # `cli` is a path, like the server module's own import of it, so a system can import both.
      nixosModules = {
        movies = import ./nix/module.nix;
        default = self.nixosModules.movies;
        cli = ./nix/cli-module.nix;
      };

      homeManagerModules = {
        movies = ./nix/home-module.nix;
        default = self.homeManagerModules.movies;
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
              service = config.systemd.services.movies;
            in
            pkgs.writeText "movies-module-check" (
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
                groups = config.users.users.movies.extraGroups;
              }
            );
        in
        {
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.movies;
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) cli;
          module = evaluate { };
          module-qsv = evaluate {
            hardwareAcceleration = "qsv";
            openFirewall = true;
            tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
            environmentFile = "/run/secrets/movies.env";
            otlpEndpoint = "http://127.0.0.1:4318";
            qsvDevice = "/dev/dri/renderD129";
            extraEnvironment.LIBVA_DRIVER_NAME = "iHD";
          };
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
                cli = builtins.any (package: package.pname or "" == "movies-cli") config.environment.systemPackages;
                convexUrl = config.environment.sessionVariables.MEDIA_CONVEX_URL or null;
                mediaUrl = config.environment.sessionVariables.MEDIA_SERVER_URL or null;
                server = config.systemd.services ? movies;
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
            pkgs.writeText "movies-cli-module-check" (builtins.toJSON actual);
          home-module =
            let
              inherit (nixpkgs) lib;
              home =
                settings:
                (lib.evalModules {
                  modules = [
                    self.homeManagerModules.movies
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
                cli = builtins.any (package: package.pname or "" == "movies-cli") config.home.packages;
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
                    MEDIA_CONVEX_URL = "http://nas:3210";
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
            pkgs.writeText "movies-home-module-check" (builtins.toJSON actual);
          vm = pkgs.callPackage ./nix/vm-test.nix { module = self.nixosModules.movies; };
        }
      );
    };
}
