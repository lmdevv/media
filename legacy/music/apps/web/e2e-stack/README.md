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

The suite expects a fresh container: the first test creates the admin account. On NixOS, set
`CHROMIUM_PATH=$(which chromium)`. CI runs it on every push (`.github/workflows/ci.yml`).
