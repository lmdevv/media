import { SourceUnreachable } from "@media/player/source-resolver";
import type { SourceResolver } from "@media/player/source-resolver";
import { Result } from "effect";

import type { DownloadedCopies } from "../downloads";

/** Why a song without a copy can't play while the phone plays its own queue. */
export const NOT_DOWNLOADED = "This song isn’t downloaded";

/**
 * This phone's sources, as old music's `localFirst`: its downloaded copy of a song first, online
 * too; otherwise `remote`'s stream while the player follows the server's queue; and nothing while
 * the phone plays its own queue without the server, so the player skips the song at once instead
 * of waiting for a connection. A copy that fails to play is discarded, so the song streams, or is
 * skipped offline, when it loads again; downloads fetch it again when its file is broken.
 *
 * @param mode - Whether the player follows the server's queue or this phone's own, read on each
 *   load.
 * @param newId - A new id, for each start of a copy.
 */
export const phoneSources = (
  copies: DownloadedCopies,
  remote: SourceResolver,
  mode: { readonly current: "server" | "local" },
  newId: () => string,
): SourceResolver => ({
  resolve: async (track, profile) => {
    const copy = copies.find(track.id);

    if (copy !== null) {
      return Result.succeed({
        origin: "local",
        source: {
          key: `${track.id}:local:${copy.uri}`,
          url: copy.uri,
          durationMs: track.durationMs,
          finished: true,
        },
        profile: copy.profile,
        renewAt: Number.MAX_SAFE_INTEGER,
        playbackId: `local:${newId()}`,
      });
    }

    if (mode.current === "local") {
      return Result.fail(new SourceUnreachable({ message: NOT_DOWNLOADED }));
    }

    return remote.resolve(track, profile);
  },
  discard: copies.discard,
});
