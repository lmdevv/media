import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, PlaybackSessionId, ProfileId, TitleId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { Episode, MediaFile } from "./catalog";

/**
 * How the media service delivers a session's file to its device: the original file over byte
 * ranges (`direct`), or fMP4 HLS with the video copied (`remux`), only the audio converted
 * (`audio-transcode`), or the video encoded on Intel Quick Sync (`transcode-qsv`), through VA-API
 * on an Intel or AMD GPU (`transcode-vaapi`), or in software (`transcode-software`).
 */
export const PlaybackMode = Schema.Literals([
  "direct",
  "remux",
  "audio-transcode",
  "transcode-qsv",
  "transcode-vaapi",
  "transcode-software",
]);

/** How a session's file reaches its device. */
export type PlaybackMode = typeof PlaybackMode.Type;

/** A device's playback, as other devices of the account see it. */
export const PlaybackSession = Schema.Struct({
  id: PlaybackSessionId,
  profileId: ProfileId,
  deviceId: DeviceId,
  deviceName: Schema.NullOr(Schema.String),
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  fileId: MediaFileId,
  mode: Schema.NullOr(PlaybackMode),
  positionMs: Milliseconds,
  state: Schema.Literals(["playing", "paused"]),
  startedAt: EpochMillis,
  lastReportAt: EpochMillis,
});

/** A device's playback. */
export interface PlaybackSession extends Schema.Schema.Type<typeof PlaybackSession> {}

/**
 * A new playback session. Send `token` to the media service in the `token` query parameter; it
 * expires at `tokenExpiresAt` (six hours) and `playback.renewToken` issues a fresh one.
 */
export const StartedPlayback = Schema.Struct({
  sessionId: PlaybackSessionId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /** The episode playing, with this profile's progress; null for movies. */
  episode: Schema.NullOr(Episode),
  file: MediaFile,
  token: Schema.String,
  tokenExpiresAt: EpochMillis,
  mediaBaseUrl: Schema.String,
  /** Where to start: saved progress, or zero when finished or never started. Rooms ignore it. */
  resumePositionMs: Milliseconds,
});

/** A new playback session. */
export interface StartedPlayback extends Schema.Schema.Type<typeof StartedPlayback> {}

/**
 * Why a device reports progress: the periodic `tick` (about every ten seconds), a `pause`,
 * `resume`, or `seek`, or `ended` when playback reached the end of the file.
 */
export const ProgressEvent = Schema.Literals(["tick", "pause", "resume", "seek", "ended"]);

/** Why a device reports progress. */
export type ProgressEvent = typeof ProgressEvent.Type;
