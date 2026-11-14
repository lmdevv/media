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
      oci-containers.containers.media-core-convex = {
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

    # Reads the whole body before checking it: `curl | grep -q` fails under pipefail when grep
    # exits at its first match and curl is still writing (exit code 23).
    def page(url):
        return machine.succeed(f"curl -fsS {url}")

    def wait_connected():
        machine.wait_until_succeeds(
            "curl -fsS http://127.0.0.1:8080/api/health | grep -q '\"backend\":\"connected\"'",
            timeout=600,
        )

    machine.wait_for_unit("podman-media-core-convex.service")
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:3210/version", timeout=300)
    machine.wait_for_unit("media-proxy.service")
    machine.wait_for_unit("movies.service", timeout=900)

    with subtest("the media service signs in to the core"):
        wait_connected()
        print(health())

    with subtest("one address serves every path"):
        assert machine.succeed("curl -fsS http://127.0.0.1:8080/convex/instance_name").strip() == "core"
        machine.fail("systemctl cat podman-movies-convex.service")
        assert machine.succeed(
            "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/movies/convex/instance_name"
        ) == "404"
        machine.succeed("curl -fsS http://127.0.0.1:8080/api/health")
        assert "<title>[media]</title>" in page("http://127.0.0.1:8080/")
        assert "<title>[media]</title>" in page("http://127.0.0.1:8080/people")
        assert "<title>[movies]</title>" in page("http://127.0.0.1:8080/movies/")
        assert "/movies/assets/" in page("http://127.0.0.1:8080/movies/some/client/route")
        assert "<title>[music]</title>" in page("http://127.0.0.1:8080/music/")
        assert "/music/assets/" in page("http://127.0.0.1:8080/music/albums/some-album")
        status, jwks = machine.execute("curl -fsS http://127.0.0.1:8080/convex/.well-known/jwks.json")
        assert status != 0 or "keys" not in jwks

    with subtest("every web client is served with the core's Convex URL"):
        machine.succeed("grep -rqF http://localhost:8080/convex /run/movies/web")
        machine.succeed("grep -rqF http://localhost:8080/convex /run/media-account")
        machine.succeed("grep -rqF http://localhost:8080/convex /run/media-music")
        machine.fail(
            "grep -rqF __MEDIA_CONVEX_URL__ /run/movies/web /run/media-account /run/media-music"
        )

    with subtest("options reach the service"):
        environ = machine.succeed(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value movies)/environ"
        )
        assert "STREAM_IDLE_SECONDS=30" in environ, environ
        assert "LIBVA_DRIVER_NAME=iHD" in environ, environ
        assert "LIBRARY_ROOTS=/srv/media/movies" in environ, environ
        assert "CONVEX_URL=http://127.0.0.1:3210" in environ, environ
        assert "CONVEX_PUBLIC_URL=http://localhost:8080/convex" in environ, environ

    with subtest("secrets stay private"):
        machine.succeed("[ \"$(stat -c '%U %a' /run/movies/media.env)\" = 'movies 600' ]")
        machine.succeed("[ \"$(stat -c '%U %a' /var/lib/media/core/backups)\" = 'movies 700' ]")
        machine.succeed("[ \"$(stat -c '%U %a' /var/lib/media/core/secrets/media-service-key)\" = 'root 600' ]")
        machine.succeed("grep -q '^MEDIA_TICKET_KEYS=.' /run/movies/media.env")
        machine.succeed(
            "[ \"$(sed -n 's/^MEDIA_SERVICE_API_KEY=//p' /run/movies/media.env)\" = "
            "\"$(cat /var/lib/media/core/secrets/media-service-key)\" ]"
        )
        machine.fail("journalctl -u movies.service | grep -qF -f /var/lib/media/core/secrets/media-service-key")
        machine.succeed("[ \"$(stat -c '%U' /proc/$(systemctl show -p MainPID --value movies))\" = movies ]")
        machine.fail(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value movies)/cmdline | grep -q 'KEY\\|SECRET'"
        )

    with subtest("the Convex instance secret is on no command line"):
        # Every command here names the secret's file, never the secret: `grep -f` reads it.
        secret = "/var/lib/media/core/convex/credentials/instance_secret"
        machine.succeed(f"grep -qxE '[0-9a-f]{{64}}' {secret}")
        assert machine.succeed(f"stat -c %a {secret} $(dirname {secret})").split() == ["600", "700"]
        machine.succeed(f"! grep -sqaF -f {secret} /proc/[0-9]*/cmdline")
        machine.succeed(
            "tr '\\0' ' ' < /proc/$(pgrep -f convex-local-backend | head -n 1)/cmdline"
            " | grep -qF -- '--instance-secret @ARGV_SECRET_FILE'"
        )
        # The setup's admin key came through the shim: the core is deployed and configured.
        machine.succeed("[ -s /var/lib/media/core/version ]")

    with subtest("the library is read-only to the service"):
        machine.fail(
            "nsenter -t $(systemctl show -p MainPID --value movies) -m touch /srv/media/movies/written"
        )

    with subtest("a restart signs in again with the same service key"):
        key = machine.succeed("cat /var/lib/media/core/secrets/media-service-key")
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") == key

    with subtest("a lost service key is issued again to the same principal"):
        service = machine.succeed("cat /var/lib/media/core/secrets/media-service-id")
        machine.succeed("rm /var/lib/media/core/secrets/media-service-key")
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-id") == service
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") != key

    with subtest("an upgrade backs up first"):
        machine.succeed("echo 0.0.0-previous > /var/lib/media/core/version")
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        machine.succeed("ls /var/lib/media/core/backups | grep -q '^core-manual-.*\\.zip$'")
        machine.succeed("[ \"$(stat -c %U /var/lib/media/core/backups/core-manual-*.zip)\" = movies ]")

    with subtest("a deployed upgrade clears its backup marker"):
        machine.fail("test -e /var/lib/media/core/upgrade-backup")
        version = machine.succeed("cat /var/lib/media/core/version").strip()
        assert "+" in version, version

    with subtest("a retried upgrade does not back up again"):
        machine.succeed(
            "cd /var/lib/media/core && cp version upgrade-backup && echo 0.0.0-previous > version"
        )
        machine.succeed("systemctl restart movies.service")
        machine.wait_for_unit("movies.service")
        wait_connected()
        count = machine.succeed("ls /var/lib/media/core/backups | grep -c '^core-manual-.*\\.zip$'").strip()
        assert count == "1", count
  '';
}
