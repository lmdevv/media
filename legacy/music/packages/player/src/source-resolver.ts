/**
 * Where the player gets the bytes for a song: a copy on this device, or a stream the server signs.
 * The controller asks for a plan each time it loads or buffers a song and never learns why one
 * was chosen; the web streams everything, and a phone with downloads plays its copies first.
 */
import type { TrackId } from "@music/commands/ids";
import type { StreamProfile, Track } from "@music/commands/models";
import type { MusicClient } from "@music/sdk/client";
import { errorMessage } from "@music/sdk/errors";
import { Data, Result } from "effect";

import type { EngineSource } from "./engine";
import type { SessionPort } from "./session-router";

/**
 * A stream URL this close to its expiry counts as expired: it is signed again before playback
 * resumes or seeks, which would otherwise send a request it may no longer cover. Also absorbs a
 * device clock a few minutes off the server's.
 */
const RENEW_MARGIN_MS = 5 * 60_000;

/** A source the engine can load, and how long it stays usable. */
export interface ResolvedSource {
  readonly source: EngineSource;
  /** The profile the bytes are in: the one asked for when streaming, the stored one for a copy. */
  readonly profile: StreamProfile;
  /**
   * When, on this device's clock, a stream URL is signed again before use: `RENEW_MARGIN_MS`
   * before it expires, or halfway through a short-lived one. Null for a copy on this device, which
   * never expires, and for a URL that looked expired the moment it arrived, which means the
   * device clock is far off the server's: only a refusal then tells that it expired.
   */
  readonly renewAt: number | null;
  /** A copy on this device, or a stream from the media service. */
  readonly origin: "local" | "stream";
}

/** The server would not sign a stream for the song: it is gone, out of reach, or the call failed. */
export class StreamRefused extends Data.TaggedError("StreamRefused")<{
  /** Safe to show the listener. */
  readonly message: string;
}> {}

/** How to get the bytes for one song right now. */
export type SourcePlan = Data.TaggedEnum<{
  /** Loads as it is: a copy on this device, or a stream already signed. */
  Ready: { readonly resolved: ResolvedSource };
  /** A stream the server signs first, when `sign` runs. */
  Stream: { readonly sign: () => Promise<Result.Result<ResolvedSource, StreamRefused>> };
  /** Nothing can provide the song now: there is no copy here, and the server can't be asked. */
  Unreachable: {};
}>;

/** Constructors and matchers for `SourcePlan`. */
export const SourcePlan = Data.taggedEnum<SourcePlan>();

/** Where the player gets bytes for a song. The controller never learns whether it is online. */
export interface SourceResolver {
  /**
   * The plan for playing `track`, streamed at `wanted` when it streams. Deciding is synchronous
   * and costs nothing: a stream is signed only when its plan's `sign` runs.
   */
  readonly resolve: (track: Track, wanted: StreamProfile) => SourcePlan;
  /** A copy on this device failed to play: stop offering it. Streams ignore it. */
  readonly discard: (trackId: TrackId) => void;
}

/**
 * Signs every song as a stream through `stream.url`. A new `requestedAt` on each call gets a newly
 * signed URL rather than an earlier one from Convex's query cache.
 *
 * @param env - The device clock, and how the host turns the URL the server signed (relative
 *   behind the image's proxy) into the one it fetches.
 */
export const streamSources = (
  client: Pick<MusicClient, "read">,
  env: { readonly now: () => number; readonly resolveUrl: (url: string) => string },
): SourceResolver => {
  const sign = async (
    track: Track,
    profile: StreamProfile,
  ): Promise<Result.Result<ResolvedSource, StreamRefused>> => {
    try {
      const requestedAt = env.now();
      const stream = await client.read("stream.url", { trackId: track.id, profile, requestedAt });
      // A short-lived URL (a Jam member's lasts minutes) is renewed halfway through instead.
      const margin = Math.min(RENEW_MARGIN_MS, (stream.expiresAt - requestedAt) / 2);
      const renewAt = stream.expiresAt - margin;

      return Result.succeed({
        profile,
        origin: "stream",
        source: {
          key: `${track.id}:${profile}`,
          url: env.resolveUrl(stream.url),
          durationMs: track.durationMs,
          finished: false,
        },
        renewAt: renewAt > requestedAt ? renewAt : null,
      });
    } catch (error) {
      return Result.fail(
        new StreamRefused({
          message: error instanceof Error ? errorMessage(error) : String(error),
        }),
      );
    }
  };

  return {
    resolve: (track, wanted) => SourcePlan.Stream({ sign: () => sign(track, wanted) }),
    discard: () => {},
  };
};

/** A song this device holds a copy of. */
export interface LocalCopy {
  /** Where the file is, as the engine loads it (`file://…` on a phone). */
  readonly uri: string;
  /** The profile the copy was stored in. */
  readonly profile: StreamProfile;
}

/** The copies this device holds, as downloads keep them. */
export interface LocalCopies {
  readonly find: (trackId: TrackId) => LocalCopy | null;
  /** A copy failed to play: stop offering it, and fetch it again when downloads next sync. */
  readonly discard: (trackId: TrackId) => void;
}

/**
 * A copy on this device first, online too; otherwise `remote`, but only while the session runs on
 * the server. While this device plays its own session the server can't sign anything, so a song
 * without a copy is `Unreachable` at once instead of a read that waits for the connection.
 */
export const localFirst = (
  copies: LocalCopies,
  remote: SourceResolver,
  session: Pick<SessionPort, "mode">,
): SourceResolver => ({
  resolve: (track, wanted) => {
    const copy = copies.find(track.id);

    if (copy !== null) {
      return SourcePlan.Ready({
        resolved: {
          profile: copy.profile,
          origin: "local",
          renewAt: null,
          source: {
            key: `${track.id}:${copy.profile}:local`,
            url: copy.uri,
            durationMs: track.durationMs,
            finished: true,
          },
        },
      });
    }

    return session.mode() === "server" ? remote.resolve(track, wanted) : SourcePlan.Unreachable();
  },
  discard: copies.discard,
});
