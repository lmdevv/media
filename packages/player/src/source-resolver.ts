import { MUSIC_STREAM_PARAMS, musicStreamPath } from "@media/contracts/music-playback";
import type { MusicStreamProfile } from "@media/contracts/music-playback";
import { TICKET_PARAM } from "@media/contracts/ticket";
import { Data, Result } from "effect";

import type { EngineSource } from "./engine";
import { messageOf } from "./failure";

/** Renew a ticket this long before it expires, as old music renewed its signed URLs. */
const RENEW_MARGIN_MS = 5 * 60_000;

/** What `music.play.start` answers: a personal ticket for one song in this session. */
export interface PlayStart {
  /** This start's own playback id, which `music.play.report` carries. */
  readonly playbackId: string;
  /** When the server started it, on the server's clock. */
  readonly startedAt: number;
  readonly ticket: string;
  /** When the ticket expires, on the server's clock. */
  readonly expiresAt: number;
}

/** A song as the player plays it. */
export interface PlayableTrack {
  readonly id: string;
  readonly durationMs: number;
}

/** A source the engine can load, and how long it stays usable. */
export interface ResolvedSource {
  readonly source: EngineSource;
  /** The profile the bytes are in. */
  readonly profile: MusicStreamProfile;
  /**
   * When, on this device's clock, the ticket is renewed before use: `RENEW_MARGIN_MS` before it
   * expires, or halfway through a short-lived one. Worked out from the ticket's lifetime, so a
   * device clock far off the server's renews on time anyway.
   */
  readonly renewAt: number;
  /** The start this ticket came from, which the play's history report names. */
  readonly playbackId: string;
  /**
   * A copy on this device, or a stream from the media server. Only a stream shows that the server
   * plays the song now: `music.play.start` refuses a song it can't play.
   */
  readonly origin: "local" | "stream";
}

/** The server would not start the song: it is gone, out of reach, or the call failed. */
export class StreamRefused extends Data.TaggedError("StreamRefused")<{
  /** Safe to show the listener. */
  readonly message: string;
}> {}

/**
 * Nothing can provide the song now: this device holds no copy of it, and the server can't be
 * asked, as while a phone plays its own queue without the server. The player moves on to the next
 * song, as old music's did.
 */
export class SourceUnreachable extends Data.TaggedError("SourceUnreachable")<{
  /** Safe to show the listener. */
  readonly message: string;
}> {}

/** Where the player gets a song's bytes: a copy on this device, or a ticket from the server. */
export interface SourceResolver {
  /** Answers `track`'s source, starting it on the server when it streams at `profile`. */
  readonly resolve: (
    track: PlayableTrack,
    profile: MusicStreamProfile,
  ) => Promise<Result.Result<ResolvedSource, StreamRefused | SourceUnreachable>>;
  /**
   * The copy of `trackId` at `url` on this device failed to play: stop offering it. Naming the URL
   * keeps a newer copy that replaced it meanwhile. Streams ignore it.
   */
  readonly discard: (trackId: string, url: string) => void;
}

/** The URL of `trackId`'s stream at `profile` on the media server at `baseUrl`, with its ticket. */
export const streamUrl = (
  baseUrl: string,
  trackId: string,
  ticket: string,
  profile: MusicStreamProfile,
): string => {
  const query = new URLSearchParams({
    [TICKET_PARAM]: ticket,
    [MUSIC_STREAM_PARAMS.profile]: profile,
  });

  return `${baseUrl}${musicStreamPath(trackId)}?${query.toString()}`;
};

/**
 * Starts every song with `music.play.start` and streams it from the media server at `baseUrl`
 * with that start's ticket. Each load gets a new ticket, so a song loaded again after its ticket
 * expired, or after the server refused it, plays with a fresh one (ADR 0010).
 *
 * @param start - Runs `music.play.start` for a song.
 * @param env - The device clock and the media server's address.
 */
export const ticketSources = (
  start: (trackId: string) => Promise<PlayStart>,
  env: { readonly now: () => number; readonly baseUrl: string },
): SourceResolver => ({
  resolve: async (track, profile) => {
    try {
      const requestedAt = env.now();
      const started = await start(track.id);
      const lifetime = Math.max(0, started.expiresAt - started.startedAt);
      const margin = Math.min(RENEW_MARGIN_MS, lifetime / 2);

      return Result.succeed({
        profile,
        origin: "stream",
        playbackId: started.playbackId,
        renewAt: requestedAt + lifetime - margin,
        source: {
          key: `${track.id}:${profile}:${started.playbackId}`,
          url: streamUrl(env.baseUrl, track.id, started.ticket, profile),
          durationMs: track.durationMs,
          finished: false,
        },
      });
    } catch (error) {
      return Result.fail(new StreamRefused({ message: messageOf(error) }));
    }
  },
  discard: () => {},
});
