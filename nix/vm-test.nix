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

  # A fresh install; `services` adds to its options.
  install =
    services:
    { pkgs, ... }:
    {
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
      }
      // services;
    };
in
testers.runNixOSTest {
  name = "media";

  nodes = {
    machine = install {
      streamIdleSeconds = 30;
      extraEnvironment.LIBVA_DRIVER_NAME = "iHD";
    };
    # Root makes no folder inside the service user's state folder, so the service user makes
    # backupDir and the folder on the way to it.
    nested = install { backupDir = "/var/lib/media/movies/media/custom/backups"; };
  };

  testScript = ''
    import json

    def health():
        return json.loads(machine.succeed("curl -fsS http://127.0.0.1:8080/api/health"))

    # Reads the whole body before checking it: `curl | grep -q` fails under pipefail when grep
    # exits at its first match and curl is still writing (exit code 23).
    def page(url):
        return machine.succeed(f"curl -fsS {url}")

    def wait_connected(node=machine):
        node.wait_until_succeeds(
            "curl -fsS http://127.0.0.1:8080/api/health | grep -q '\"backend\":\"connected\"'",
            timeout=600,
        )

    def folders_log(node=machine):
        return node.succeed(
            "journalctl -o cat _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value media-server-folders.service)"
        )

    start_all()

    nested_dirs = [
        "/var/lib/media/movies/media",
        "/var/lib/media/movies/media/custom",
        "/var/lib/media/movies/media/custom/backups",
    ]

    def nested_owners():
        for path in nested_dirs:
            found = nested.succeed(f"stat -c '%U:%G %a' {path}").strip()
            assert found == "media-server:media-server 700", f"{path} is {found}"

    with subtest("a fresh install with backupDir inside the state folder starts"):
        nested.wait_for_unit("media-server.service", timeout=900)
        wait_connected(nested)
        nested_owners()

    with subtest("the command the check names for a missing backupDir makes every missing folder the service user's"):
        # Another owner's file in the state folder stops the check before it makes anything.
        nested.succeed("systemctl stop media-server.service")
        nested.succeed(f"rm -rf {nested_dirs[1]} && install -o 9999 -g 9999 /dev/null {nested_dirs[0]}/old")
        status, _ = nested.execute("systemctl start media-server.service")
        assert status != 0, "the media service started"
        log = folders_log(nested)
        print(log)
        fix = f"install -d -m 700 -o media-server -g media-server {nested_dirs[1]} {nested_dirs[2]}"
        assert f"refusing to start: {nested_dirs[2]} is missing; make it with: sudo {fix}" in log, log
        nested.succeed(fix)
        nested_owners()
        nested.succeed(f"rm {nested_dirs[0]}/old && systemctl reset-failed")
        nested.succeed("systemctl start media-server.service")
        nested.wait_for_unit("media-server.service")
        wait_connected(nested)
        nested.shutdown()

    machine.wait_for_unit("podman-media-core-convex.service")
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:3210/version", timeout=300)
    machine.wait_for_unit("media-proxy.service")
    machine.wait_for_unit("media-server.service", timeout=900)

    with subtest("the media service signs in to the core"):
        wait_connected()
        print(health())

    with subtest("one address serves every path"):
        assert machine.succeed("curl -fsS http://127.0.0.1:8080/convex/instance_name").strip() == "core"
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

    with subtest("the module makes its folders, root's or the service user's, and no tmpfiles rule does"):
        modes = {
            "/var/lib/media": "root 711",
            "/var/lib/media/core": "root 711",
            "/var/lib/media/core/convex": "root 700",
            "/var/lib/media/core/secrets": "root 700",
            "/var/lib/media/movies": "root 711",
            "/var/lib/media/movies/media": "media-server 700",
            "/var/lib/media/core/backups": "media-server 700",
            "/var/cache/media": "root 755",
            "/var/cache/media/transcode": "media-server 700",
        }
        for path, expected in modes.items():
            found = machine.succeed(f"stat -c '%U %a' {path}").strip()
            assert found == expected, f"{path} is {found}, not {expected}"
        machine.fail("systemd-tmpfiles --cat-config | grep -E '/var/lib/media|/var/cache/media'")

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

    # Nothing outside [media]'s folders may change in the cases below: each path's inode, owner,
    # mode, and link count.
    def listing(*paths):
        return machine.succeed(f"find {' '.join(paths)} -printf '%i %u:%g %m %n %p\\n' | sort")

    def owner(path):
        return machine.succeed(f"stat -c %u:%g {path}").strip()

    def start_refused():
        status, _ = machine.execute("systemctl start media-server.service")
        assert status != 0, "the media service started"
        machine.fail("systemctl is-active media-server.service")
        log = folders_log()
        print(log)
        machine.succeed("systemctl reset-failed")
        return log

    def start():
        machine.succeed("systemctl start media-server.service")
        machine.wait_for_unit("media-server.service")
        wait_connected()

    state = "/var/lib/media/movies/media"
    backups = "/var/lib/media/core/backups"
    transcodes = "/var/cache/media/transcode"
    service_ids = machine.succeed("echo \"$(id -u media-server):$(getent group media-server | cut -d: -f3)\"").strip()

    # The command the check prints for folders of another owner, without its `sudo`.
    def printed_fix(log):
        return [
            line.removeprefix("media-server-folders: sudo ")
            for line in log.splitlines()
            if line.startswith("media-server-folders: sudo find")
        ]

    def fix_for(*folders):
        return (
            f"find {' '.join(folders)} -xdev \\( -type d -o -links 1 \\) -execdir chown -h media-server:media-server {{}} +"
        )

    # 9999 stands in for a user and group that no longer exist.
    with subtest("folders of another owner refuse the start until the admin runs the chown it names"):
        key = machine.succeed("cat /var/lib/media/core/secrets/media-service-key")
        machine.succeed("systemctl stop media-server.service")
        machine.succeed(f"touch {state}/theirs && mkdir -p {transcodes}/downloads")
        machine.succeed(f"chown -R 9999:9999 {state} {backups} {transcodes}")
        before = listing(state, backups, transcodes)
        log = start_refused()
        assert listing(state, backups, transcodes) == before
        assert f"{state} belongs to uid 9999 and gid 9999, not media-server:media-server" in log, log
        assert "first check that no process runs as uid 9999: pgrep -u 9999 must print nothing" in log, log
        commands = printed_fix(log)
        assert commands == [fix_for(transcodes, backups, state)], commands
        machine.succeed(commands[0])
        start()
        machine.succeed(f"test -e {state}/theirs")
        machine.succeed(f"ls {backups} | grep -q '^core-manual-.*\\.zip$'")
        owners = machine.succeed(f"find {state} {backups} {transcodes} -printf '%u:%g\\n' | sort -u").split()
        assert owners == ["media-server:media-server"], owners
        assert machine.succeed("cat /var/lib/media/core/secrets/media-service-key") == key

    with subtest("a library file hard-linked into the state folder keeps its owner, through the printed fix too"):
        # A library file of another owner's, hard-linked into a state folder of that owner's: a
        # recursive chown of the folder would re-own it.
        machine.succeed("systemctl stop media-server.service")
        machine.succeed("install -o 9999 -g 9999 -m 644 /dev/null /srv/media/movies/library-file")
        machine.succeed(f"ln /srv/media/movies/library-file {state}/linked && chown 9999:9999 {state}")
        library = listing("/srv/media")
        commands = printed_fix(start_refused())
        assert commands == [fix_for(state)], commands
        machine.succeed(commands[0])
        assert listing("/srv/media") == library
        log = start_refused()
        assert f"refusing to start: {state}/linked, in {state}, is another user's and has other names" in log, log
        assert listing("/srv/media") == library
        machine.succeed(f"rm {state}/linked /srv/media/movies/library-file")
        start()

    with subtest("a library mounted at or inside a folder of [media]'s stops the start, and keeps its owner and mode"):
        machine.succeed("systemctl stop media-server.service")
        machine.succeed("install -o 9999 -g 9999 -m 644 /dev/null /srv/media/movies/library-file")
        library = listing("/srv/media")
        for folder, refusal in [
            (state, f"refusing to start: {state} is a mount point"),
            (transcodes, f"refusing to start: {transcodes} is a mount point"),
            ("/var/lib/media/movies", "refusing to start: /var/lib/media/movies is a mount point"),
        ]:
            machine.succeed(f"mount --bind /srv/media/movies {folder}")
            log = start_refused()
            machine.succeed(f"umount {folder}")
            assert refusal in log, log
            # A fix would cross into the mount, so the check prints none.
            assert printed_fix(log) == [], log
            assert listing("/srv/media") == library
        machine.succeed(f"mkdir {state}/mounted && mount --bind /srv/media/movies {state}/mounted")
        log = start_refused()
        machine.succeed(f"umount {state}/mounted && rmdir {state}/mounted")
        assert f"refusing to start: {state}/mounted is mounted inside {state}" in log, log
        assert listing("/srv/media") == library
        machine.succeed("rm /srv/media/movies/library-file")
        start()

    with subtest("a symlinked dataDir stops everything before it starts, and no tmpfiles rule follows it"):
        # Another install's state behind the symlink, its database folder of another owner and mode.
        machine.succeed("systemctl stop media-server.service podman-media-core-convex.service")
        machine.succeed("mkdir -p /srv/other/core/convex /srv/other/movies/media && touch /srv/other/core/convex/theirs")
        machine.succeed("chown -R 9999:9999 /srv/other && chmod 2775 /srv/other/core/convex")
        machine.succeed("mv /var/lib/media /var/lib/media.real && ln -s /srv/other /var/lib/media")
        other = listing("/srv/other")
        machine.succeed("systemd-tmpfiles --create")
        status, _ = machine.execute("systemctl start media-server.service")
        assert status != 0, "the media service started through the symlink"
        machine.fail("systemctl is-active podman-media-core-convex.service")
        assert listing("/srv/other") == other
        assert "refusing to start: /var/lib/media is a symlink to /srv/other" in folders_log()
        machine.succeed("rm /var/lib/media && mv /var/lib/media.real /var/lib/media")
        machine.succeed("systemctl reset-failed")
        start()

    with subtest("a symlink on the way to the state folder stops the start"):
        machine.succeed("systemctl stop media-server.service")
        machine.succeed("mkdir -p /srv/elsewhere/media && touch /srv/elsewhere/media/theirs && chown -R 9999:9999 /srv/elsewhere")
        machine.succeed("mv /var/lib/media/movies /var/lib/media/movies.real && ln -s /srv/elsewhere /var/lib/media/movies")
        elsewhere = listing("/srv/elsewhere")
        log = start_refused()
        assert "refusing to start: /var/lib/media/movies is a symlink to /srv/elsewhere" in log, log
        assert listing("/srv/elsewhere") == elsewhere
        machine.succeed("rm /var/lib/media/movies && mv /var/lib/media/movies.real /var/lib/media/movies")
        start()

    with subtest("nothing is made below a folder another user can change, even while it swaps the folder"):
        # uid 9999 owns transcodeDir's parent, and swaps transcodeDir between a folder and a symlink
        # to the library as fast as it can, while the service tries to start.
        machine.succeed("systemctl stop media-server.service")
        machine.succeed(f"rm -rf {transcodes} && chown 9999:9999 /var/cache/media")
        library = listing("/srv/media")
        machine.succeed(
            "systemd-run --unit=swapper $(command -v setpriv) --reuid=9999 --regid=9999 --clear-groups"
            " $(command -v sh) -c 'export PATH=/run/current-system/sw/bin; cd /var/cache/media &&"
            " while :; do rm -rf transcode; mkdir transcode; rm -rf transcode; ln -s /srv/media/movies transcode; done'"
        )
        machine.wait_until_succeeds("test -L /var/cache/media/transcode", timeout=30)
        for _ in range(5):
            start_refused()
        machine.succeed("systemctl is-active swapper && systemctl stop swapper")
        assert listing("/srv/media") == library
        # Made by the admin, it is still refused while that user can swap it.
        machine.succeed(f"rm -rf {transcodes} && install -d -m 700 -o media-server -g media-server {transcodes}")
        log = start_refused()
        assert f"refusing to start: /var/cache/media, on the way to {transcodes}, belongs to uid 9999" in log, log
        machine.succeed(f"rm -rf {transcodes} && chown root:root /var/cache/media")
        start()
        assert owner(transcodes) == service_ids
  '';
}
