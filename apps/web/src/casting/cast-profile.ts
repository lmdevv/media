/**
 * What casting sends to a Chromecast, as plain data the SDK adapter turns into Cast objects. The
 * device negotiates through the same playback ladder as a browser, with the client profile in
 * `@media/contracts/cast`. The receiver fetches media itself, so URLs are the
 * absolute ones the media service hands out, with the session's playback token in the query (a
 * receiver cannot send headers).
 */
import type { NegotiateResponse } from "@media/contracts/media-playback";

import { subtitleTrackLabels } from "@/lib/media-facts";

/** IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`) and unspecified (`::ffff:0.0.0.0`) addresses. */
const MAPPED_LOCAL = /^\[::ffff:(?:7f[\da-f]{2}:[\da-f]{1,4}|0:0)\]$/;

/**
 * Whether `mediaBaseUrl` names this computer only (`localhost`, a loopback address) or no computer
 * at all (`0.0.0.0`, `::`, a bind address), which a Chromecast on the network cannot reach.
 */
export const localOnly = (mediaBaseUrl: string): boolean => {
  const host = URL.canParse(mediaBaseUrl) ? new URL(mediaBaseUrl).hostname : "";

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    MAPPED_LOCAL.test(host)
  );
};

/** What is playing, as the TV shows it. */
export interface CastItem {
  /** The movie's name, or the episode's. */
  readonly title: string;
  /** For an episode: the show, season, and episode numbers. */
  readonly episode: {
    readonly seriesTitle: string;
    readonly season: number;
    readonly episode: number;
  } | null;
  /** An absolute poster or still URL. */
  readonly imageUrl: string | null;
}

/** A WebVTT subtitle track the receiver can show. */
export interface CastTextTrack {
  /** The receiver's numeric track ID. */
  readonly trackId: number;
  /** The player's subtitle ID (`e3`, `x0`). */
  readonly subtitleId: string;
  readonly url: string;
  readonly name: string;
  readonly language: string;
}

/** Everything a receiver needs to play a stream. */
export interface CastLoadPlan {
  readonly contentUrl: string;
  readonly contentType: string;
  /** fMP4 HLS, as the media service streams it; otherwise a direct MP4 file. */
  readonly hls: boolean;
  readonly durationSeconds: number;
  /** Where the receiver starts playing. */
  readonly startSeconds: number;
  readonly item: CastItem;
  readonly tracks: ReadonlyArray<CastTextTrack>;
  /** The track to show, as receiver track IDs. */
  readonly activeTrackIds: ReadonlyArray<number>;
}

/** The receiver track ID of the subtitle `subtitleId`, or none. */
export const castTrackIds = (
  tracks: ReadonlyArray<CastTextTrack>,
  subtitleId: string | null,
): ReadonlyArray<number> =>
  tracks.flatMap((track) => (track.subtitleId === subtitleId ? [track.trackId] : []));

/**
 * The load plan for `stream` at `positionSeconds`, showing subtitle `subtitleId`. Only text
 * subtitles with a WebVTT URL travel; picture subtitles are not offered to the receiver.
 */
export const castLoadPlan = (
  stream: Pick<NegotiateResponse, "mode" | "url" | "durationSeconds" | "subtitles">,
  item: CastItem,
  subtitleId: string | null,
  positionSeconds: number,
): CastLoadPlan => {
  const labels = subtitleTrackLabels(stream.subtitles);

  const tracks = stream.subtitles.flatMap((track, index) =>
    track.url === undefined
      ? []
      : [
          {
            trackId: index + 1,
            subtitleId: track.id,
            url: track.url,
            name: labels[index] ?? track.id,
            language: track.language ?? "und",
          },
        ],
  );

  const hls = stream.mode !== "direct";

  return {
    contentUrl: stream.url,
    contentType: hls ? "application/x-mpegurl" : "video/mp4",
    hls,
    durationSeconds: stream.durationSeconds,
    startSeconds: Math.max(0, positionSeconds),
    item,
    tracks,
    activeTrackIds: castTrackIds(tracks, subtitleId),
  };
};
