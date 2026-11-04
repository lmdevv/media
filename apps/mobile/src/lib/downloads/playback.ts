import { PlaybackSessionId } from "@media/contracts/ids";
import type { NegotiateResponse } from "@media/contracts/media-playback";
import { Milliseconds } from "@media/contracts/units";
import { EpochMillis } from "@media/contracts/units";
import type { Playback } from "@media/sdk/effect";

import type { DownloadRecord } from "./model";

/**
 * How long a local stream counts as valid. The player renews a stream before it expires; a local
 * file never needs it, and a week stays inside what a timer can wait for.
 */
const LOCAL_STREAM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a download's files are on this iPhone. */
export interface KeptFiles {
  readonly video: string;
  readonly subtitle: (trackId: string) => string;
}

/**
 * The playback of a ready download at its last position here, else the profile's saved position
 * when it was downloaded; null for one that is not ready.
 */
export const downloadPlayback = (
  download: DownloadRecord,
  files: KeptFiles,
  now: number,
): Playback.Playback | null => {
  const { delivery, playback } = download;

  if (download.phase !== "ready" || delivery === null || playback === null) return null;

  const startMs = download.positionMs > 0 ? download.positionMs : playback.resumePositionMs;
  const expiresAt = now + LOCAL_STREAM_LIFETIME_MS;

  const stream: NegotiateResponse = {
    mode: "direct",
    url: files.video,
    startSeconds: startMs / 1000,
    durationSeconds: delivery.durationMs / 1000,
    video: {
      codec: delivery.videoCodec,
      width: delivery.width,
      height: delivery.height,
      dynamicRange: "sdr",
    },
    audio: delivery.audio ?? undefined,
    subtitles: delivery.subtitles.map((subtitle) => ({
      id: subtitle.id,
      source: "sidecar",
      codec: "webvtt",
      kind: "text",
      language: subtitle.language ?? undefined,
      title: subtitle.title ?? undefined,
      forced: subtitle.forced,
      default: subtitle.default,
      hearingImpaired: subtitle.hearingImpaired,
      url: files.subtitle(subtitle.id),
    })),
    expiresAt,
  };

  return {
    started: {
      sessionId: PlaybackSessionId.make(`download-${download.id}`),
      titleId: download.titleId,
      episodeId: download.episodeId,
      episode: playback.episode,
      file: playback.file,
      token: "",
      tokenExpiresAt: EpochMillis.make(expiresAt),
      mediaBaseUrl: "",
      resumePositionMs: Milliseconds.make(startMs),
    },
    stream,
  };
};
