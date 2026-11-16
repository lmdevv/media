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

  nodes.machine = { pkgs, ... }: {
    imports = [ module ];

    environment.systemPackages = [ pkgs.jq ];

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
    machine.wait_for_unit("media-server.service", timeout=900)

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
        machine.succeed("grep -rqF http://localhost:8080/convex /run/media-server/web")
        machine.succeed("grep -rqF http://localhost:8080/convex /run/media-account")
        machine.succeed("grep -rqF http://localhost:8080/convex /run/media-music")
        machine.fail(
            "grep -rqF __MEDIA_CONVEX_URL__ /run/media-server/web /run/media-account /run/media-music"
        )

    with subtest("options reach the service"):
        environ = machine.succeed(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value media-server)/environ"
        )
        assert "STREAM_IDLE_SECONDS=30" in environ, environ
        assert "LIBVA_DRIVER_NAME=iHD" in environ, environ
        assert "LIBRARY_ROOTS=/srv/media/movies" in environ, environ
        assert "CONVEX_URL=http://127.0.0.1:3210" in environ, environ
        assert "CONVEX_PUBLIC_URL=http://localhost:8080/convex" in environ, environ

    with subtest("secrets stay private"):
        machine.succeed("[ \"$(stat -c '%U %a' /run/media-server/media.env)\" = 'media-server 600' ]")
        machine.succeed("[ \"$(stat -c '%U %a' /var/lib/media/core/backups)\" = 'media-server 700' ]")
        machine.succeed("[ \"$(stat -c '%U %a' /var/lib/media/core/secrets/media-service-key)\" = 'root 600' ]")
        machine.succeed("grep -q '^MEDIA_TICKET_KEYS=.' /run/media-server/media.env")
        machine.succeed(
            "[ \"$(sed -n 's/^MEDIA_SERVICE_API_KEY=//p' /run/media-server/media.env)\" = "
            "\"$(cat /var/lib/media/core/secrets/media-service-key)\" ]"
        )
        machine.fail("journalctl -u media-server.service | grep -qF -f /var/lib/media/core/secrets/media-service-key")
        machine.succeed("[ \"$(stat -c '%U' /proc/$(systemctl show -p MainPID --value media-server))\" = media-server ]")
        machine.fail(
            "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value media-server)/cmdline | grep -q 'KEY\\|SECRET'"
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
            "nsenter -t $(systemctl show -p MainPID --value media-server) -m touch /srv/media/movies/written"
        )

    with subtest("a restart signs in again with the same service key"):
        key = machine.succeed("cat /var/lib/media/core/secrets/media-service-key")
        machine.succeed("systemctl restart media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") == key

    with subtest("a lost service key is issued again to the same principal"):
        service = machine.succeed("cat /var/lib/media/core/secrets/media-service-id")
        machine.succeed("rm /var/lib/media/core/secrets/media-service-key")
        machine.succeed("systemctl restart media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-id") == service
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") != key

    with subtest("an upgrade backs up first"):
        machine.succeed("echo 0.0.0-previous > /var/lib/media/core/version")
        machine.succeed("systemctl restart media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()
        machine.succeed("ls /var/lib/media/core/backups | grep -q '^core-manual-.*\\.zip$'")
        machine.succeed("[ \"$(stat -c %U /var/lib/media/core/backups/core-manual-*.zip)\" = media-server ]")

    with subtest("a deployed upgrade clears its backup marker"):
        machine.fail("test -e /var/lib/media/core/upgrade-backup")
        version = machine.succeed("cat /var/lib/media/core/version").strip()
        assert "+" in version, version

    with subtest("a retried upgrade does not back up again"):
        machine.succeed(
            "cd /var/lib/media/core && cp version upgrade-backup && echo 0.0.0-previous > version"
        )
        machine.succeed("systemctl restart media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()
        count = machine.succeed("ls /var/lib/media/core/backups | grep -c '^core-manual-.*\\.zip$'").strip()
        assert count == "1", count

    # 0.3.0 and 0.4.0 ran the service as `movies` in these same folders and kept no record of whom
    # they belong to. Once nothing declares that user and group, NixOS drops them and keeps their
    # ids in /var/lib/nixos; 9999 stands in for them. Each case below starts from that state: no
    # record of the owner, and files of the old `movies` ids, which the handover re-owns.
    folders = "/var/lib/media/movies/media /var/lib/media/core/backups /var/cache/media/transcode"
    service_ids = machine.succeed("echo \"$(id -u media-server):$(getent group media-server | cut -d: -f3)\"").strip()

    def as_after_0_4_0():
        machine.succeed("systemctl stop media-server.service")
        machine.succeed("rm -f /var/lib/media/core/service-owner")
        for kind in ["uid", "gid"]:
            machine.succeed(
                f"jq -c '. + {{movies: 9999}}' /var/lib/nixos/{kind}-map > /tmp/{kind}-map"
                f" && mv /tmp/{kind}-map /var/lib/nixos/{kind}-map"
            )

    def owner(path):
        return machine.succeed(f"stat -c %u:%g {path}").strip()

    with subtest("an install from 0.4.0 keeps its data under the new service user"):
        key = machine.succeed("cat /var/lib/media/core/secrets/media-service-key")
        as_after_0_4_0()
        machine.succeed("touch /var/lib/media/movies/media/from-0.4.0")
        machine.succeed("mkdir -p /var/cache/media/transcode/downloads")
        machine.succeed(f"chown -R 9999:9999 {folders}")
        # Someone else's file in the service's folder is not the old service's, so it stays theirs.
        machine.succeed("install -o 8888 -g 8888 /dev/null /var/lib/media/movies/media/someone-elses")
        machine.succeed("systemctl start media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()
        machine.succeed("test -e /var/lib/media/movies/media/from-0.4.0")
        machine.succeed("ls /var/lib/media/core/backups | grep -q '^core-manual-.*\\.zip$'")
        owners = machine.succeed(
            f"find {folders} ! -name someone-elses -printf '%u:%g\\n' | sort -u"
        ).split()
        assert owners == ["media-server:media-server"], owners
        assert owner("/var/lib/media/movies/media/someone-elses") == "8888:8888"
        assert machine.succeed("cat /var/lib/media/core/service-owner").strip() == service_ids
        assert machine.succeed("stat -c '%U %a' /var/lib/media/core/service-owner").strip() == "root 600"
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") == key
        machine.succeed("rm /var/lib/media/movies/media/someone-elses")

    with subtest("a symlink on the path of the service's folders stops the start before any chown"):
        # Another install's files, owned by the very ids the handover takes over from, behind a
        # symlinked parent of the service's state.
        as_after_0_4_0()
        machine.succeed("mkdir -p /srv/elsewhere/media && touch /srv/elsewhere/media/theirs")
        machine.succeed("chown -R 9999:9999 /srv/elsewhere")
        machine.succeed("mv /var/lib/media/movies /var/lib/media/movies.real")
        machine.succeed("ln -s /srv/elsewhere /var/lib/media/movies")
        status, _ = machine.execute("systemctl start media-server.service")
        for path in ["/srv/elsewhere", "/srv/elsewhere/media", "/srv/elsewhere/media/theirs"]:
            assert owner(path) == "9999:9999", f"{path} is now {owner(path)}"
        assert status != 0, "the media service started through the symlink"
        machine.succeed(
            "journalctl -u media-server-handover.service | grep -q 'refusing to start: a symlink on the path of /var/lib/media/movies/media'"
        )
        machine.succeed("rm /var/lib/media/movies && mv /var/lib/media/movies.real /var/lib/media/movies")
        machine.succeed("systemctl reset-failed")
        machine.succeed("systemctl start media-server.service")
        wait_connected()

    with subtest("files mounted inside the service's folders keep their owner"):
        # A bind mount from the same disk keeps the device number, so stopping at other file systems
        # alone would walk into it. Here it is the library, with a file of the old service's ids.
        as_after_0_4_0()
        machine.succeed("install -o 9999 -g 9999 -m 644 /dev/null /srv/media/movies/library-file")
        machine.succeed("install -o 9999 -g 9999 /dev/null /var/lib/media/movies/media/from-0.4.0-too")
        machine.succeed("mkdir /var/lib/media/movies/media/mounted")
        machine.succeed("mount --bind /srv/media/movies /var/lib/media/movies/media/mounted")
        machine.succeed("systemctl start media-server.service")
        wait_connected()
        for path in ["/srv/media/movies", "/srv/media/movies/library-file"]:
            expected = "0:0" if path == "/srv/media/movies" else "9999:9999"
            assert owner(path) == expected, f"{path} is now {owner(path)}"
        assert owner("/var/lib/media/movies/media/from-0.4.0-too") == service_ids
        machine.succeed("umount /var/lib/media/movies/media/mounted && rmdir /var/lib/media/movies/media/mounted")
        machine.succeed("rm /srv/media/movies/library-file /var/lib/media/movies/media/from-0.4.0-too")
  '';
}
