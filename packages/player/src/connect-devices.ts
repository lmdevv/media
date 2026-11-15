import { positionAt } from "./connect-player";
import type { ConnectItem } from "./connect-player";

/** Connect counts a device that has not reported for this long as offline (ADR 0018). */
export const ONLINE_MS = 30_000;

/** A device as `core.connect.targets.list` answers it, in the fields the music clients read. */
export interface ConnectTarget {
  readonly deviceId: string;
  readonly name: string;
  readonly mode: "personal" | "shared";
  readonly playback: {
    readonly domain: string;
    /** Null when the caller may not play it. */
    readonly item: ConnectItem | null;
    readonly playing: boolean;
    readonly positionMs: number;
    readonly at: number;
    /** A request the device has not applied yet stands in for its report. */
    readonly pending: boolean;
  } | null;
  readonly reportedAt: number;
}

/** What a device plays, in server time: a song, or music the caller may not see. */
export interface DevicePlayback {
  /** Null when the caller may not play the song. */
  readonly trackId: string | null;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly at: number;
  readonly pending: boolean;
}

/** One of the listener's own devices other than this one, online now. */
export interface Device {
  readonly id: string;
  readonly name: string;
  /** Null while it plays no music. */
  readonly playback: DevicePlayback | null;
}

const musicOf = (target: ConnectTarget): DevicePlayback | null => {
  const { playback } = target;

  if (playback?.domain !== "music") return null;

  const { item } = playback;

  return {
    trackId: item?.ref.type === "track" ? item.ref.id : null,
    playing: playback.playing,
    positionMs: playback.positionMs,
    at: playback.at,
    pending: playback.pending,
  };
};

/**
 * `devices` by name, then id, inserted in order: the phone app's JavaScript engine (Hermes) has no
 * `toSorted`, and lint forbids `sort`. The list is a person's few devices.
 */
const byName = (devices: ReadonlyArray<Device>): ReadonlyArray<Device> => {
  const sorted: Array<Device> = [];

  const compare = (left: Device, right: Device): number =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id);

  for (const device of devices) {
    const at = sorted.findIndex((other) => compare(device, other) < 0);

    if (at === -1) sorted.push(device);
    else sorted.splice(at, 0, device);
  }

  return sorted;
};

/**
 * The listener's own devices besides `self` that reported within {@link ONLINE_MS} of `serverNow`,
 * by name, so a device's heartbeat never moves it in the list. Shared devices, which old music
 * never listed, stay out (D62): the list is a person's personal devices, as old music's was.
 */
export const ownDevices = (
  targets: ReadonlyArray<ConnectTarget>,
  self: string | null,
  serverNow: number,
): ReadonlyArray<Device> =>
  byName(
    targets.flatMap((target) =>
      target.mode !== "personal" ||
      target.deviceId === self ||
      serverNow - target.reportedAt > ONLINE_MS
        ? []
        : [{ id: target.deviceId, name: target.name, playback: musicOf(target) }],
    ),
  );

/**
 * The device the player follows while nothing plays here, as old music's active device: one that
 * plays music, else one that holds music paused. `previous` keeps its place while it still
 * qualifies as well as any other, so two devices that report in turn never swap.
 */
export const activeDevice = (
  devices: ReadonlyArray<Device>,
  previous: string | null,
): Device | null => {
  const holding = devices.filter((device) => device.playback !== null);
  const playing = holding.filter((device) => device.playback?.playing === true);
  const pool = playing.length > 0 ? playing : holding;

  return pool.find((device) => device.id === previous) ?? pool[0] ?? null;
};

/**
 * Whether this device, holding a song paused, should let it go: another of the listener's devices
 * plays music, so it took playback over, as a newly active device stopped the old one in old music.
 */
export const yieldsTo = (
  here: { readonly playing: boolean } | null,
  devices: ReadonlyArray<Device>,
) => here !== null && !here.playing && devices.some((device) => device.playback?.playing === true);

/** Where `device` stands in its song at server time `serverNow`, held at the song's end. */
export const devicePosition = (
  playback: DevicePlayback,
  serverNow: number,
  durationMs: number,
): number => {
  const position = positionAt(playback, serverNow);

  return durationMs > 0 ? Math.min(position, durationMs) : position;
};

/** What a device is, as old music's device lists told them apart: a computer's browser or a phone. */
export type DeviceKind = "web" | "phone";

/** The names the account client gives browsers, such as `Firefox on Linux` or `Safari`. */
const BROWSER_NAME = /^(?:Edge|Firefox|Chrome|Safari|Browser)(?: on (?<system>.+))?$/u;

/** The systems whose browsers old music counted as phones. */
const PHONE_SYSTEMS = new Set(["iPhone", "Android"]);

/**
 * Whether a device is a computer's browser or a phone, from its name, as old music told them apart:
 * the core keeps no kind, and a browser's name is the one the account client gave it at sign-in. A
 * browser on an iPhone or Android counts as a phone, and so does any other name, such as the phone
 * app's.
 */
export const deviceKind = (name: string): DeviceKind => {
  const system = BROWSER_NAME.exec(name)?.groups?.["system"];

  return BROWSER_NAME.test(name) && !PHONE_SYSTEMS.has(system ?? "") ? "web" : "phone";
};
