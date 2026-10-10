/**
 * The player contract the web app builds on. `PlayerProvider` mirrors the user's Convex playback
 * session, plays audio when this browser is the active device, and reports position back.
 *
 * This file currently holds a remote-control-only implementation: it reads and changes the
 * session but produces no sound. The audio implementation replaces the internals and keeps
 * this contract.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type { Device, RepeatMode, Track } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

export interface PlayerState {
  readonly status: PlayerStatus;
  readonly track: Track | null;
  readonly queue: ReadonlyArray<Track>;
  readonly index: number;
  readonly durationMs: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  readonly volume: number;
  /** This browser's device ID, stable per browser profile. */
  readonly deviceId: DeviceId | null;
  /** The device that outputs audio, or null when none is chosen. */
  readonly activeDevice: Device | null;
  /** True when this browser outputs the audio. */
  readonly isThisDevice: boolean;
  /** False when the media service cannot be reached; browsing still works. */
  readonly mediaOnline: boolean;
  readonly error: string | null;
}

export interface PlayerActions {
  readonly playTracks: (trackIds: ReadonlyArray<TrackId>, index?: number) => Promise<void>;
  readonly togglePlay: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly previous: () => Promise<void>;
  readonly seek: (positionMs: number) => Promise<void>;
  readonly jump: (index: number) => Promise<void>;
  readonly setShuffle: (on: boolean) => Promise<void>;
  readonly setRepeat: (mode: RepeatMode) => Promise<void>;
  readonly setVolume: (volume: number) => Promise<void>;
  readonly addToQueue: (trackIds: ReadonlyArray<TrackId>, next?: boolean) => Promise<void>;
  readonly removeFromQueue: (index: number) => Promise<void>;
  /** Moves playback to this browser. */
  readonly playHere: () => Promise<void>;
  readonly transferTo: (deviceId: DeviceId) => Promise<void>;
}

export type Player = PlayerState & PlayerActions;

const PlayerContext = createContext<Player | null>(null);

const PositionContext = createContext<number>(0);

/** The player state and actions. Must be inside `PlayerProvider`. */
export const usePlayer = (): Player => {
  const player = useContext(PlayerContext);

  if (player === null) throw new Error("usePlayer must be used inside PlayerProvider");

  return player;
};

/** The live position in milliseconds. Separate from `usePlayer` because it changes often. */
export const usePlayerPosition = (): number => useContext(PositionContext);

export function PlayerProvider({ children }: { readonly children: ReactNode }) {
  const state = useRead("playback.state", {});
  const play = useRun("playback.play");
  const pause = useRun("playback.pause");
  const resume = useRun("playback.resume");
  const next = useRun("playback.next");
  const previous = useRun("playback.previous");
  const seek = useRun("playback.seek");
  const jump = useRun("playback.jump");
  const shuffle = useRun("playback.shuffle");
  const repeat = useRun("playback.repeat");
  const volume = useRun("playback.volume");
  const queueAdd = useRun("queue.add");
  const queueRemove = useRun("queue.remove");
  const transfer = useRun("playback.transfer");

  const player = useMemo((): Player => {
    const track = state?.queue[state.index] ?? null;

    const done = async (promise: Promise<unknown>): Promise<void> => {
      await promise;
    };

    return {
      status:
        state === undefined ? "loading" : state.playing ? "playing" : track ? "paused" : "idle",
      track,
      queue: state?.queue ?? [],
      index: state?.index ?? 0,
      durationMs: track?.durationMs ?? 0,
      shuffle: state?.shuffle ?? false,
      repeat: state?.repeat ?? "off",
      volume: state?.volume ?? 1,
      deviceId: null,
      activeDevice: state?.activeDevice ?? null,
      isThisDevice: false,
      mediaOnline: true,
      error: null,
      playTracks: (ids, index) =>
        done(play(index === undefined ? { trackIds: ids } : { trackIds: ids, index })),
      togglePlay: () => done(state?.playing === true ? pause({}) : resume({})),
      next: () => done(next({})),
      previous: () => done(previous({})),
      seek: (positionMs) => done(seek({ positionMs })),
      jump: (index) => done(jump({ index })),
      setShuffle: (on) => done(shuffle({ on })),
      setRepeat: (mode) => done(repeat({ mode })),
      setVolume: (value) => done(volume({ volume: value })),
      addToQueue: (ids, toFront) =>
        done(
          queueAdd(toFront === undefined ? { trackIds: ids } : { trackIds: ids, next: toFront }),
        ),
      removeFromQueue: (index) => done(queueRemove({ index })),
      playHere: async () => {},
      transferTo: (deviceId) => done(transfer({ deviceId })),
    };
  }, [
    state,
    play,
    pause,
    resume,
    next,
    previous,
    seek,
    jump,
    shuffle,
    repeat,
    volume,
    queueAdd,
    queueRemove,
    transfer,
  ]);

  return (
    <PlayerContext.Provider value={player}>
      <PositionContext.Provider value={state?.positionMs ?? 0}>{children}</PositionContext.Provider>
    </PlayerContext.Provider>
  );
}
