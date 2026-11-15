import { usePlatformQuery } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import { activeDevice, ownDevices, yieldsTo } from "./connect-devices";
import type { Device } from "./connect-devices";
import { ConnectPlayer, systemConnectClock } from "./connect-player";
import type { ConnectCommands } from "./connect-player";
import type { ControllerSnapshot, PlaybackController } from "./playback-controller";
import { followLead } from "./tab-lead";
import type { TabLead, TabLocks } from "./tab-lead";

/** How often the device list looks again for devices that went quiet, as time passes. */
const ONLINE_CHECK_MS = 5000;

/** Songs an album load reads at most, as the album screen's play button does. */
const ALBUM_LIMIT = 1000;

/** Songs asked for per page of an album; the core caps a page to what one call may read. */
const ALBUM_PAGE = 100;

/** The lock the tabs of one browser elect their device's voice with. */
const LEAD_LOCK = "media.music.connect";

type Sdk = PlatformSdk;

type Report = Parameters<Sdk["core"]["connect"]["player"]["report"]>[0];

type ReportedPlayback = Exclude<Report["playback"], null>;

/** A device id as the core's commands take it. */
type DeviceId = Parameters<Sdk["core"]["connect"]["targets"]["control"]>[0]["deviceId"];

/** An item as Connect's commands take it: a song or an album, as `core.connect.targets.load` does. */
export type MusicItem = Extract<
  Parameters<Sdk["core"]["connect"]["targets"]["load"]>[0]["item"],
  { readonly domain: "music" }
>;

type MusicRef = ReportedPlayback["item"] & { readonly domain: "music" };

type TrackRef = Extract<MusicRef["ref"], { readonly type: "track" }>;

type AlbumId = Parameters<Sdk["music"]["albums"]["tracks"]>[0]["albumId"];

/** Ids the core answered in its own lists and requests, handed back to it. */
const asDeviceId = Brand.nominal<DeviceId>();

const asTrackId = Brand.nominal<TrackRef["id"]>();

const asAlbumId = Brand.nominal<AlbumId>();

const connectCommands = (platform: Sdk): ConnectCommands => ({
  report: async (song, applied) => {
    const playback: ReportedPlayback | null =
      song === null
        ? null
        : {
            item: { domain: "music", ref: { type: "track", id: asTrackId(song.trackId) } },
            playing: song.playing,
            positionMs: song.positionMs,
          };

    const { reportedAt } = await platform.core.connect.player.report({
      output: { kind: "local" },
      playback,
      applied,
    });

    return reportedAt;
  },
  albumTracks: async (albumId) => {
    const collect = async (
      cursor: string | null,
      loaded: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<string>> => {
      const page = await platform.music.albums.tracks({
        albumId: asAlbumId(albumId),
        paginationOpts: { numItems: ALBUM_PAGE, cursor },
      });

      if (!page.isDone && page.continueCursor === cursor) {
        throw new Error("The album's songs stopped advancing");
      }

      const ids = [...loaded, ...page.page.map((track) => track.id)];

      return page.isDone || ids.length >= ALBUM_LIMIT
        ? ids.slice(0, ALBUM_LIMIT)
        : collect(page.continueCursor, ids);
    };

    return collect(null, []);
  },
});

const browserLocks = (): TabLocks | undefined =>
  typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined;

/** Connect as the player sees it: this device, the listener's other devices, and the one it follows. */
export interface ConnectView {
  /** This browser's device; null until the core says, or for a session on no device. */
  readonly deviceId: string | null;
  /** The listener's other own devices that are online, newest report first. */
  readonly devices: ReadonlyArray<Device>;
  /** The device whose music the player follows while nothing plays here; null otherwise. */
  readonly remote: Device | null;
  /** Whether a song is loaded here, playing or paused. */
  readonly here: boolean;
  /** The device side, to drop requests the listener's own actions made moot. */
  readonly player: ConnectPlayer;
  /** Makes this tab the one that reports for the browser's device; resolves once it is. */
  readonly lead: () => Promise<void>;
  /** The server's time now. */
  readonly serverNow: () => number;
}

const useOnlineCheck = (active: boolean): number => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return undefined;

    const timer = setInterval(() => {
      setTick((count) => count + 1);
    }, ONLINE_CHECK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return tick;
};

/**
 * Runs this browser as a Connect device for the player (ADR 0018), and lists the listener's other
 * devices. One tab per browser reports and applies requests; a tab that plays takes that over.
 * A song held paused here goes when another of the listener's devices plays, as old music's single
 * active device did.
 */
export const useConnect = (
  platform: Sdk,
  controller: PlaybackController,
  local: ControllerSnapshot,
): ConnectView => {
  const me = usePlatformQuery(platform.core.auth.sessions.current);
  const deviceId = me.status === "success" ? (me.data.device?.deviceId ?? null) : null;

  const [player] = useState(
    () => new ConnectPlayer(controller, connectCommands(platform), systemConnectClock),
  );

  const [leading, setLeading] = useState(false);
  const election = useRef<TabLead | null>(null);

  useEffect(() => {
    if (deviceId === null) return undefined;
    const lead = followLead(browserLocks(), LEAD_LOCK, setLeading);

    election.current = lead;

    return () => {
      lead.stop();
      election.current = null;
    };
  }, [deviceId]);

  useEffect(() => (leading ? player.start() : undefined), [player, leading]);

  const requested = usePlatformQuery(
    platform.core.connect.player.requested,
    ...(leading ? [{}] : (["skip"] as const)),
  );

  useEffect(() => {
    if (requested.status === "success") player.take(requested.data);
  }, [player, requested]);

  // Read on each render: `local`, which re-renders this, changes whenever a song loads here or goes.
  const playingHere = local.engineStatus === "idle" ? null : controller.playingHere();
  const here = playingHere !== null;
  const pausedHere = playingHere !== null && !playingHere.playing;

  useEffect(() => {
    if (here && !leading) void election.current?.take();
  }, [here, leading]);

  const targets = usePlatformQuery(
    platform.core.connect.targets.list,
    ...(deviceId === null ? (["skip"] as const) : [{}]),
  );

  const listed = targets.status === "success" ? targets.data : null;
  const tick = useOnlineCheck(listed !== null && listed.length > 0);

  const online = useMemo(
    () => (listed === null ? [] : ownDevices(listed, deviceId, player.serverNow())),
    // `tick` drops a device that went quiet once its last report is 30 seconds old.
    [listed, deviceId, player, tick],
  );

  const devices = useStable(online);

  const previous = useRef<string | null>(null);
  const remote = here ? null : activeDevice(devices, previous.current);

  useEffect(() => {
    previous.current = remote?.id ?? null;
  }, [remote]);

  useEffect(() => {
    if (leading && yieldsTo(pausedHere ? { playing: false } : null, devices)) controller.release();
  }, [leading, pausedHere, devices, controller]);

  return useMemo(
    () => ({
      deviceId,
      devices,
      remote,
      here,
      player,
      lead: async () => election.current?.take(),
      serverNow: () => player.serverNow(),
    }),
    [deviceId, devices, remote, here, player],
  );
};

/**
 * `devices` as last answered while it holds the same devices playing the same way, so a device's
 * heartbeat, which changes nothing shown, never re-renders the player's readers.
 */
const useStable = (devices: ReadonlyArray<Device>): ReadonlyArray<Device> => {
  const key = JSON.stringify(devices);
  const [held, setHeld] = useState({ key, devices });

  if (held.key === key) return held.devices;
  setHeld({ key, devices });

  return devices;
};

export { asDeviceId };
