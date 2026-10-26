#!/usr/bin/env bash
# Installs ffmpeg on a GitHub-hosted Ubuntu runner (.github/workflows/ci.yml).
#
# The runner's apt mirror list puts Azure's Ubuntu mirror first. When that mirror stops answering,
# apt waits out a timeout on every file before it tries the next mirror, and a job can hang for
# hours. Dropping it leaves archive.ubuntu.com, which later apt steps in the job (Playwright's
# `--with-deps`) use too. Short timeouts with retries turn a dead mirror into a fast failure.
set -euo pipefail

mirrors=/etc/apt/apt-mirrors.txt

if [ -f "$mirrors" ]; then
  sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$mirrors"
fi

apt=(sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

"${apt[@]}" update
"${apt[@]}" install -y ffmpeg
