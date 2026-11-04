#!/bin/sh
# Runs a command in a private network namespace whose only interface is its own loopback, as an
# unprivileged user and network namespace (`unshare --user --map-root-user --net`). The command
# keeps the host's files, binaries, and user, but nothing on the host network reaches it, and it
# never sees host interfaces change. Chromium cancels its queued requests whenever any host
# interface gains or loses an address, which every Docker container start and stop does, so
# browser runs on a host with other Docker work belong in here.
#
#   scripts/private-network.sh pnpm --filter web exec playwright test --project=kit
#
# Needs Linux with unprivileged user namespaces, util-linux's `unshare`, and iproute2's `ip`. It
# fails rather than run the command on the host network.
exec unshare --user --map-root-user --net sh -c 'ip link set lo up && exec "$@"' sh "$@"
