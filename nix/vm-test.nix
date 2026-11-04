# NixOS VM test of the module: boots a machine with `services.media` enabled, starts the pinned
# Convex backend (from a fixed-output image, since the test has no network) and the media service,
# and checks that the service signs in to Convex, serves the web app, keeps its secrets private,
# and survives a restart.
#
#   nix build .#checks.x86_64-linux.vm -L
#
# After a change to deploy/convex-backend.image, update `imageHashes` with
#   nix run nixpkgs#nix-prefetch-docker -- --image-name <name> --image-digest <digest> --arch amd64
# (and --arch arm64).
{
  lib,
  testers,
  dockerTools,
  stdenv,
  module,
}:
let
  pinned = lib.fileContents ../deploy/convex-backend.image;
  parts = builtins.match "([^:@]+):([^@]+)@(sha256:[0-9a-f]+)" pinned;
  imageName = builtins.elemAt parts 0;
  imageTag = builtins.elemAt parts 1;
  imageDigest = builtins.elemAt parts 2;

  imageHashes = {
    x86_64-linux = "sha256-eLkV9+hlHkBkbF9bag8e2nB4m5GEuH7niOh09q02u1U=";
    aarch64-linux = "sha256-Mb/uNkGVLPeuOmeUXrUyzOnGg4OGNBem0Du3qlLb+WU=";
  };

  convexImage = dockerTools.pullImage {
    inherit imageName imageDigest;
    hash = imageHashes.${stdenv.hostPlatform.system};
    finalImageName = imageName;
    finalImageTag = imageTag;
  };
in
testers.runNixOSTest {
  name = "movies";

  nodes.machine = {
    imports = [ module ];

    virtualisation = {
      memorySize = 4096;
      cores = 4;
      diskSize = 8192;
      # The loaded image has no registry digest, so the container runs it by name and tag.
      oci-containers.containers.movies-convex = {
        imageFile = convexImage;
        pull = "never";
      };
    };

    systemd.tmpfiles.rules = [ "d /srv/media/movies 0755 root root -" ];

    services.media = {
      enable = true;
      libraryDirs = [ "/srv/media/movies" ];
      convexImage = "${imageName}:${imageTag}";
      streamIdleSeconds = 30;
      extraEnvironment.LIBVA_DRIVER_NAME = "iHD";
    };
  };

  testScript = ''
    import json

    def health():
        return json.loads(machine.succeed("curl -fsS http://127.0.0.1:8080/api/health"))

    def wait_connected():
        machine.wait_until_succeeds(
            "curl -fsS http://127.0.0.1:8080/api/health | grep -q '\"backend\":\"connected\"'",
            timeout=600,
        )

    machine.wait_for_unit("podman-movies-convex.service")
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:3210/version", timeout=300)
    machine.wait_for_unit("movies.service", timeout=900)

    with subtest("the media service signs in to Convex"):
        wait_connected()
        print(health())

    with subtest("the web app is served with the deployment's Convex URL"):
        page = machine.succeed("curl -fsS http://127.0.0.1:8080/")
        assert "<div id=\"app\"" in page, page
        machine.succeed("grep -rqF http://localhost:3210 /run/movies/web")
        machine.fail("grep -rqF __MEDIA_CONVEX_URL__ /run/movies/web")
        machine.succeed("curl -fsS http://127.0.0.1:8080/some/client/route | grep -qF '<div id=\"app\"'")

    with subtest("options reach the service"):
        environ = machine.succeed(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value movies)/environ"
        )
        assert "STREAM_IDLE_SECONDS=30" in environ, environ
        assert "LIBVA_DRIVER_NAME=iHD" in environ, environ
        assert "LIBRARY_ROOTS=/srv/media/movies" in environ, environ

    with subtest("secrets stay private"):
        machine.succeed("[ \"$(stat -c '%U %a' /run/movies/media.env)\" = 'movies 600' ]")
        machine.succeed("[ \"$(stat -c '%a' /var/lib/movies/backups)\" = 700 ]")
        machine.succeed("[ \"$(stat -c '%U' /proc/$(systemctl show -p MainPID --value movies))\" = movies ]")
        machine.fail(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value movies)/cmdline | grep -q 'KEY\\|SECRET'"
        )

    with subtest("the library is read-only to the service"):
        machine.fail(
            "nsenter -t $(systemctl show -p MainPID --value movies) -m touch /srv/media/movies/written"
        )

    with subtest("a restart signs in again"):
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()

    with subtest("an upgrade backs up first"):
        machine.succeed("echo 0.0.0-previous > /var/lib/movies/media/version")
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        machine.succeed("ls /var/lib/movies/backups | grep -q '^movies-manual-.*\\.zip$'")

    with subtest("a deployed upgrade clears its backup marker"):
        machine.fail("test -e /var/lib/movies/media/upgrade-backup")
        version = machine.succeed("cat /var/lib/movies/media/version").strip()
        assert "+" in version, version

    with subtest("a retried upgrade does not back up again"):
        machine.succeed(
            "cd /var/lib/movies/media && cp version upgrade-backup && echo 0.0.0-previous > version"
        )
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        count = machine.succeed("ls /var/lib/movies/backups | grep -c '^movies-manual-.*\\.zip$'").strip()
        assert count == "1", count
  '';
}
