/**
 * What casting sends to a Chromecast, as plain data the SDK adapter turns into Cast objects. The
 * device negotiates through the same playback ladder as a browser, with the client profile in
 * `@media/contracts/cast`. The receiver fetches media itself, so URLs are the absolute ones the
 * media server hands out, with the receiver credential it lent for the start in the ticket's
 * place (ADR 0011): a receiver cannot send headers, and it never holds the ticket.
 */
import { withReceiverCredential } from "@media/contracts/cast";
import type { NegotiateResponse } from "@media/contracts/media-playback";

import { subtitleTrackLabels } from "@/lib/media-facts";

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
  /** fMP4 HLS, as the media server streams it; otherwise a direct MP4 file. */
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
 * The load plan for `stream` at `positionSeconds`, showing subtitle `subtitleId`, with every URL
 * carrying `credential` in place of the start's ticket. Only text subtitles with a WebVTT URL
 * travel; picture subtitles are not offered to the receiver.
 */
export const castLoadPlan = (
  stream: Pick<NegotiateResponse, "mode" | "url" | "durationSeconds" | "subtitles">,
  item: CastItem,
  subtitleId: string | null,
  positionSeconds: number,
  credential: string,
): CastLoadPlan => {
  const labels = subtitleTrackLabels(stream.subtitles);

  const tracks = stream.subtitles.flatMap((track, index) =>
    track.url === undefined
      ? []
      : [
          {
            trackId: index + 1,
            subtitleId: track.id,
            url: withReceiverCredential(track.url, credential),
            name: labels[index] ?? track.id,
            language: track.language ?? "und",
          },
        ],
  );

  const hls = stream.mode !== "direct";

  return {
    contentUrl: withReceiverCredential(stream.url, credential),
    contentType: hls ? "application/x-mpegurl" : "video/mp4",
    hls,
    durationSeconds: stream.durationSeconds,
    startSeconds: Math.max(0, positionSeconds),
    item,
    tracks,
    activeTrackIds: castTrackIds(tracks, subtitleId),
  };
};
