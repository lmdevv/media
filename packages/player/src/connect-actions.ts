import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

import { devicePosition } from "./connect-devices";
import type { Device } from "./connect-devices";
import type { PlaybackController } from "./playback-controller";
import { nextIndex, previousIndex } from "./queue-order";
import type { RepeatMode } from "./queue-order";
import { asDeviceId } from "./use-connect";
import type { ConnectView, MusicItem } from "./use-connect";

const asItemId = Brand.nominal<Parameters<PlatformSdk["music"]["queue"]["jump"]>[0]["itemId"]>();

type TrackRef = Extract<MusicItem["ref"], { readonly type: "track" }>;

const asTrackId = Brand.nominal<TrackRef["id"]>();

/** What a play, pause, skip, or seek does: here, or on the device the player follows. */
export interface TransportActions {
  /** Replaces the queue and plays it on this device from `index`. */
  readonly playTracks: (trackIds: ReadonlyArray<string>, index?: number) => Promise<void>;
  readonly togglePlay: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly previous: () => Promise<void>;
  readonly seek: (positionMs: number) => Promise<void>;
  readonly jump: (itemId: string) => Promise<void>;
}

interface RemoteContext {
  readonly platform: PlatformSdk;
  readonly controller: PlaybackController;
  readonly connect: ConnectView;
  readonly device: Device;
  readonly entries: ReadonlyArray<{ readonly itemId: string }>;
  /** Where the current entry is in `entries`; null when the queue does not hold it yet. */
  readonly index: number | null;
  readonly repeat: RepeatMode;
  readonly durationMs: number;
}

/**
 * Playback on the device the player follows: play, pause, and seek ask that device
 * (`core.connect.targets.control`); skips move the queue it plays, which it follows; and playing a
 * list here takes playback back, pausing that device.
 */
export const remoteActions = ({
  platform,
  controller,
  connect,
  device,
  entries,
  index,
  repeat,
  durationMs,
}: RemoteContext): TransportActions => {
  const deviceId = asDeviceId(device.id);
  const playing = device.playback?.playing === true;

  const control = (change: { readonly playing: boolean } | { readonly positionMs: number }) =>
    controller.capture(platform.core.connect.targets.control({ deviceId, ...change }));

  const jumpTo = async (at: number | null): Promise<void> => {
    const entry = at === null ? undefined : entries[at];

    if (entry !== undefined) {
      await controller.capture(platform.music.queue.jump({ itemId: asItemId(entry.itemId) }));
    }
  };

  const positionMs = (): number => {
    const playback = connect.playbackOf(device.id);

    return playback === null ? 0 : devicePosition(playback, connect.serverNow(), durationMs);
  };

  return {
    playTracks: async (ids, at) => {
      if (playing) void control({ playing: false });
      await controller.playTracks(ids, at);
    },
    togglePlay: () => control({ playing: !playing }),
    next: async () => {
      if (index !== null) await jumpTo(nextIndex(index, entries.length, repeat));
    },
    previous: async () => {
      if (index === null) return;
      const at = previousIndex(positionMs(), index, entries.length, repeat);

      await (at === index ? control({ positionMs: 0 }) : jumpTo(at));
    },
    seek: (target) => control({ positionMs: Math.max(0, Math.round(target)) }),
    jump: async (itemId) => {
      await controller.capture(platform.music.queue.jump({ itemId: asItemId(itemId) }));
    },
  };
};

/** Resolves whether `call` landed, without rejecting. */
const succeeded = async (call: Promise<unknown>): Promise<boolean> => {
  try {
    await call;

    return true;
  } catch {
    return false;
  }
};

type CurrentSong = { readonly id: string } | null;

/**
 * Moves playback from the device the player follows to this device at the same place in the song
 * (`core.connect.targets.move`). Call it inside the tap, so a browser lets the song start. With
 * nothing playing anywhere, this device takes the current song, paused where it stands. Resolves
 * whether the core took it.
 */
export const moveHere = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  track: CurrentSong,
): Promise<boolean> => {
  const self = connect.deviceId;
  const { remote } = connect;

  // Inside the tap, so the browser lets the song start once the move lands here.
  controller.primeOutput();

  if (self === null) return false;

  if (remote === null) {
    if (connect.here || track === null) return true;
    connect.player.supersede();

    return controller.playCurrentAt(track.id, controller.positionMs(), false);
  }

  // This tab applies the load the move makes of this browser's device, not another tab of it.
  await connect.lead();

  return succeeded(
    platform.core.connect.targets.move({ from: asDeviceId(remote.id), to: asDeviceId(self) }),
  );
};

/**
 * Moves playback to another of the listener's devices at the same place in the song, from this
 * device or the device the player follows; with nothing playing anywhere it plays the current song
 * there from where it stands here. Resolves whether the core took it.
 */
export const moveTo = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  target: string,
  track: CurrentSong,
): Promise<boolean> => {
  const self = connect.deviceId;
  const { remote } = connect;
  const { move, load } = platform.core.connect.targets;

  if (self === null) return false;

  const from = connect.here ? self : (remote?.id ?? null);

  if (from === target) return true;

  if (from !== null) {
    return succeeded(move({ from: asDeviceId(from), to: asDeviceId(target) }));
  }

  if (track === null) return false;

  return succeeded(
    load({
      deviceId: asDeviceId(target),
      item: { domain: "music", ref: { type: "track", id: asTrackId(track.id) } },
      positionMs: Math.round(controller.positionMs()),
    }),
  );
};

/**
 * Plays a song or an album on another device (`core.connect.targets.load`), which takes playback
 * over: this device stops, or the device the player followed pauses. Resolves whether the core
 * took it.
 */
export const playOn = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  deviceId: string,
  item: MusicItem,
): Promise<boolean> => {
  const { load, control } = platform.core.connect.targets;
  const loaded = await succeeded(load({ deviceId: asDeviceId(deviceId), item }));
  const { remote } = connect;

  if (!loaded) return false;

  if (connect.here) {
    connect.player.supersede();
    controller.release();
  } else if (remote !== null && remote.id !== deviceId && remote.playback?.playing === true) {
    void succeeded(control({ deviceId: asDeviceId(remote.id), playing: false }));
  }

  return true;
};
