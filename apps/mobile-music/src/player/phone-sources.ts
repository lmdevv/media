import { SourceUnreachable } from "@media/player/source-resolver";
import type { SourceResolver } from "@media/player/source-resolver";
import { Option, Result } from "effect";

import type { DownloadedCopies } from "../downloads";
import { withDeadline } from "./deadline";

/** Why a song without a copy can't play while the phone plays its own queue. */
export const NOT_DOWNLOADED = "This song isn’t downloaded";

/** Why the player moved to the phone's own queue: the server stopped answering. */
export const SERVER_AWAY = "Can’t reach the server. Downloaded songs play without it.";

/** How the phone tells that a source the server leaves unanswered means the server is away. */
export interface AwayCheck {
  /** How long a source may go unanswered before the phone asks whether the server is there. */
  readonly deadlineMs: number;
  /** Whether the media server answers its health check. */
  readonly answers: () => Promise<boolean>;
  /** Moves the player onto the phone's own queue, before the source's failure reaches it. */
  readonly away: () => void;
}

/**
 * `remote`, with an answer bounded in time. A source the server leaves unanswered past
 * `deadlineMs`, while its health check fails too, fails as `SourceUnreachable` once the phone has
 * gone its own way, so the player skips to the next song it holds instead of waiting through the
 * outage: a `music.play.start` sent as the phone left home Wi-Fi in a pocket never answers, and no
 * engine error ever fires. A slow server that still answers keeps its call. The call itself goes
 * on, and its late answer reaches no one.
 */
export const boundedSources = (remote: SourceResolver, check: AwayCheck): SourceResolver => ({
  resolve: async (track, profile, reach) => {
    const pending = remote.resolve(track, profile, reach);
    const answered = await withDeadline(pending, check.deadlineMs);

    if (Option.isSome(answered)) return answered.value;

    if (await check.answers()) return pending;
    check.away();

    return Result.fail(new SourceUnreachable({ message: SERVER_AWAY }));
  },
  discard: remote.discard,
});

/**
 * This phone's sources, as old music's `localFirst`: its downloaded copy of a song first, online
 * too; otherwise `remote`'s stream while the player follows the server's queue; and nothing while
 * the phone plays its own queue without the server, so the player skips the song at once instead
 * of waiting for a connection, or while the player asks for this phone's copies alone. A copy that fails to play is discarded, so the song streams, or is
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
  resolve: async (track, profile, reach) => {
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

    if (mode.current === "local" || reach === "device") {
      return Result.fail(new SourceUnreachable({ message: NOT_DOWNLOADED }));
    }

    return remote.resolve(track, profile, reach);
  },
  discard: copies.discard,
});
