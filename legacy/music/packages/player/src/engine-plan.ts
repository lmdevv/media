/**
 * What the audio engine should do when the Convex playback session changes. Pure: the provider
 * feeds it the previous and next session snapshots plus what the engine has loaded, then runs the
 * returned commands in order.
 *
 * Changes are edge-triggered: the engine follows a field only when the server value changed
 * between snapshots. The session query also re-runs for unrelated writes (device heartbeats,
 * shuffle), and level-triggered rules would undo optimistic local changes (a pause still in
 * flight) or a gapless advance the server has not heard about yet.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type { PlaybackState, QueueEntry, RepeatMode } from "@music/commands/models";
import { Data } from "effect";

import { livePosition } from "./live-position";

/** A server position more than this far from the engine's counts as a seek. */
const SEEK_THRESHOLD_MS = 1500;

/** The session as one device sees it. */
export interface SessionView {
  /** True when this device is the session's active device. */
  readonly active: boolean;
  readonly index: number;
  /** The queue entry at `index`, or null when the queue is empty. */
  readonly track: QueueEntry | null;
  readonly positionMs: number;
  readonly updatedAt: number;
  readonly playing: boolean;
  readonly volume: number;
}

/** Projects the session onto one device. */
export const sessionView = (state: PlaybackState, deviceId: DeviceId): SessionView => ({
  active: state.activeDevice?.id === deviceId,
  index: state.index,
  track: state.queue[state.index] ?? null,
  positionMs: state.positionMs,
  updatedAt: state.updatedAt,
  playing: state.playing,
  volume: state.volume,
});

/** What the engine holds right now. */
export interface LocalPlayback {
  /** The track the engine loaded (or is loading), or null when unloaded. */
  readonly trackId: TrackId | null;
  /** The engine's last reported position. */
  readonly positionMs: number;
  /**
   * The position this device last sent with `playback.report`, or null. A server position equal
   * to it is this device's own report coming back, never a seek, even when the device clock is
   * off from the server clock by more than the seek threshold.
   */
  readonly reportedMs: number | null;
}

/** One step for the engine, run in order. */
export type EngineCommand = Data.TaggedEnum<{
  /** Stop output and release the audio. */
  Unload: {};
  /** Load the queue entry at `index` and start at `startMs`. */
  Load: {
    readonly track: QueueEntry;
    readonly index: number;
    readonly startMs: number;
    readonly autoplay: boolean;
  };
  /**
   * The engine already plays this track; it is now the entry `track` at `index` in the queue (the
   * same song, moved, or queued again as another entry).
   */
  AdoptIndex: { readonly index: number; readonly track: QueueEntry };
  Play: {};
  Pause: {};
  Seek: { readonly positionMs: number };
  SetVolume: { readonly volume: number };
}>;

/** Constructors and matchers for `EngineCommand`. */
export const EngineCommand = Data.taggedEnum<EngineCommand>();

/**
 * The commands that bring the engine in line with `next`. Pass `previous = null` to force a full
 * resync (first snapshot, or after the media service came back).
 */
export const planEngine = (
  previous: SessionView | null,
  next: SessionView,
  local: LocalPlayback,
  now: number,
): ReadonlyArray<EngineCommand> => {
  if (!next.active || next.track === null) {
    return local.trackId === null ? [] : [EngineCommand.Unload()];
  }

  const target = livePosition(next, now, next.track.durationMs);

  const load = (track: QueueEntry): ReadonlyArray<EngineCommand> => [
    EngineCommand.SetVolume({ volume: next.volume }),
    EngineCommand.Load({ track, index: next.index, startMs: target, autoplay: next.playing }),
  ];

  if (previous === null || !previous.active || local.trackId === null) return load(next.track);

  const commands: Array<EngineCommand> = [];

  const entryChanged =
    previous.index !== next.index ||
    previous.track?.id !== next.track.id ||
    previous.track.itemId !== next.track.itemId;

  if (entryChanged && next.track.id !== local.trackId) return load(next.track);

  if (entryChanged) {
    commands.push(EngineCommand.AdoptIndex({ index: next.index, track: next.track }));
  }

  if (previous.volume !== next.volume) {
    commands.push(EngineCommand.SetVolume({ volume: next.volume }));
  }

  const positionWritten =
    (previous.positionMs !== next.positionMs || previous.updatedAt !== next.updatedAt) &&
    next.positionMs !== local.reportedMs;

  if (positionWritten && Math.abs(target - local.positionMs) > SEEK_THRESHOLD_MS) {
    commands.push(EngineCommand.Seek({ positionMs: target }));
  }

  if (previous.playing !== next.playing) {
    commands.push(next.playing ? EngineCommand.Play() : EngineCommand.Pause());
  }

  return commands;
};

/**
 * The queue index that plays after `index` finishes on its own, or null when playback stops or
 * repeats the same entry (`repeat: "one"`, handled by seeking to the start).
 */
export const followingIndex = (
  index: number,
  queueLength: number,
  repeat: RepeatMode,
): number | null => {
  if (repeat === "one") return null;

  if (index + 1 < queueLength) return index + 1;

  return repeat === "all" && queueLength > 0 ? 0 : null;
};
