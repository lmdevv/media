# Real-stack end-to-end tests

These tests run against the [music] container: real Convex, the real media service and scanner,
real audio in Chromium, and the built `music` CLI. They cover first-run setup with a real scan,
playing, pausing, and skipping with audio actually advancing, search, an API key driving the CLI
that controls the browser's playback, and handing playback to a second browser.

```sh
scripts/stack-e2e.sh                       # build the image, generated fixture library
MUSIC_DIR=~/music scripts/stack-e2e.sh     # your own library
IMAGE=ghcr.io/lmdevv/music:main scripts/stack-e2e.sh
```

Before and after the suite, `scripts/stack-e2e.sh` checks how the container is put together:
each service runs as its own non-root user, secrets and the database stay private to their owner,
the media user finds no secret in any `/proc/*/cmdline` or `/proc/*/environ`, `/healthz` fails
while the media service is down, an upgrade from an image that only recorded `/data/version`
backs up first and keeps the newest five backups, and a stop and start keeps the data without a
new backup.

The suite expects a fresh container: the first test creates the admin account. The script also
passes the container name as `MUSIC_CONTAINER`; the device-pruning test runs the container's Convex
CLI through `docker exec` to import long-silent devices and run the prune, and is skipped without
it. On NixOS, set
`CHROMIUM_PATH=$(which chromium)`. CI runs it on every push (`.github/workflows/ci.yml`).

`first-audio.ts` is not part of the suite: it measures time to first audio, from tapping a song's
play button to its audio advancing, for every song of one album. Run it on a fresh container so
each play is a first play; the comment at its top has the commands.
