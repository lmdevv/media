# NixOS VM test: boots a machine with services.music, the image loaded from `imageFile`, and
# checks that the web app, the Convex API, the media service, and /healthz answer through the
# published port, that a library folder is mounted where the module says, and that the data
# survives a service restart.
#
#   nix build -L .#checks.x86_64-linux.vm     # needs KVM; CI runs it
#   nix build .#checks.x86_64-linux.vm.driver # builds the VM without running it
#
# The image is the 0.2.0 release, pulled by digest so the test is reproducible; it exercises the
# module, while scripts/stack-e2e.sh exercises the image of each commit.
{ pkgs, module }:
let
  image = pkgs.dockerTools.pullImage {
    imageName = "ghcr.io/lmdevv/music";
    imageDigest = "sha256:d0b19fce0acee3b39519e11c5b86343e1abf9f2c028ec41337c03704c73ab51e";
    hash = "sha256-i1Q+1mu+LYQC2vDBJ8H/b701R+vzR1V6pEv2SbW9Ng4=";
    finalImageName = "ghcr.io/lmdevv/music";
    finalImageTag = "0.2.0";
    os = "linux";
    arch = "amd64";
  };
in
pkgs.testers.runNixOSTest {
  name = "music";

  nodes.machine = {
    imports = [ module ];

    virtualisation = {
      memorySize = 4096;
      diskSize = 8192;
      cores = 2;
    };

    systemd.tmpfiles.rules = [
      "d /srv/music 0755 root root -"
      "f /srv/music/readme.txt 0644 root root - not music"
    ];

    services.music = {
      enable = true;
      image = "ghcr.io/lmdevv/music:0.2.0";
      imageFile = image;
      musicDirs.library = "/srv/music";
      extraEnvironment.BACKUP_KEEP = "3";
    };
  };

  testScript = ''
    import json
    import shlex
    from datetime import timedelta

    def sign_in(flow):
        body = json.dumps({
            "path": "auth:signIn",
            "format": "json",
            "args": {
                "provider": "password",
                "params": {"email": "vm@music.test", "password": "vm-test-password-1", "flow": flow, "name": "VM"},
            },
        })
        return machine.succeed(
            "curl -fsS -X POST http://127.0.0.1:8080/convex/api/action -H 'Content-Type: application/json' -d "
            + shlex.quote(body)
        )

    machine.wait_for_unit("podman-music.service")
    # The first start generates secrets and deploys the Convex functions.
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8080/healthz", timeout=timedelta(minutes=15))
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8080/media/health | grep -q '\"ok\":true'", timeout=timedelta(minutes=5))

    with subtest("the web app, the Convex API, and the media service answer"):
        machine.succeed("curl -fsS http://127.0.0.1:8080/ | grep -q '<title>\\[music\\]</title>'")
        machine.succeed("curl -fsS http://127.0.0.1:8080/convex/version")
        machine.succeed("curl -fsS http://127.0.0.1:8080/sign-in | grep -q '<title>'")

    with subtest("the port is published on localhost only"):
        machine.succeed("ss -ltnH | grep -q '127.0.0.1:8080 '")
        machine.fail("ss -ltnH | grep -E '(0\\.0\\.0\\.0|\\[::\\]|\\*):8080 '")

    with subtest("the library folder is mounted read-only under its name"):
        machine.succeed("podman exec music cat /music/library/readme.txt | grep -q 'not music'")
        machine.fail("podman exec music touch /music/library/new")

    with subtest("the environment reaches the container"):
        machine.succeed("podman exec music printenv BACKUP_KEEP | grep -qx 3")
        machine.succeed("podman exec music printenv PUBLIC_URL | grep -qx http://localhost:8080")

    with subtest("the database and secrets survive a restart of the service"):
        # A row written through Convex: the first sign-up creates the admin account.
        assert '"tokens"' in sign_in("signUp"), "sign-up failed"
        machine.succeed("test -s /var/lib/music/secrets/instance_secret")
        secret = machine.succeed("cat /var/lib/music/secrets/instance_secret")
        machine.succeed("systemctl restart podman-music.service")
        machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8080/media/health | grep -q '\"ok\":true'", timeout=timedelta(minutes=5))
        assert machine.succeed("cat /var/lib/music/secrets/instance_secret") == secret
        # Reading it back: the same password signs in, and setup reports an account exists.
        assert '"tokens"' in sign_in("signIn"), "the account did not survive the restart"
        machine.succeed(
            "curl -fsS -X POST http://127.0.0.1:8080/convex/api/query -H 'Content-Type: application/json' "
            + "-d '{\"path\":\"setup:status\",\"format\":\"json\",\"args\":{}}' | grep -q '\"hasUsers\":true'"
        )
  '';
}
