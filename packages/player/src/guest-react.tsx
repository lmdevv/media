import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { GuestQueue } from "./guest-queue";
import { browserEngines } from "./browser-engine";
import { setMediaSessionHandlers, showNowPlaying } from "./media-session";
import type { ControllerSnapshot } from "./playback-controller";
import { PlaybackController } from "./playback-controller";
import { usePositionTicks } from "./position-ticks";
import { ticketSources } from "./source-resolver";

type Detail = Awaited<ReturnType<PlatformSdk["music"]["playback"]["get"]>>;

/** A song returned by the playback reads, without catalog or household fields. */
export type GuestTrack = Extract<Detail, { readonly kind: "track" }>;

const createGuestPlayer = (
  platform: PlatformSdk,
  tracks: ReadonlyArray<GuestTrack>,
  baseUrl: string,
) => {
  const songs = tracks.map((track) => ({ ...track, codec: "", lossless: false }));
  const queue = new GuestQueue(songs, (state) => controller.sync(state));

  const sources = ticketSources(
    async (id) => {
      const track = await queue.track(id);

      return platform.music.play.start({ trackId: track.id });
    },
    { now: Date.now, baseUrl },
  );

  const controller = new PlaybackController(
    {
      play: queue.play,
      track: queue.track,
      jump: queue.jump,
      report: async (id, playbackId) => {
        const track = await queue.track(id);
        await platform.music.play.report({ trackId: track.id, playbackId });
      },
    },
    sources,
    browserEngines(),
    {
      canPlay: () => false,
      now: Date.now,
      monotonicNow: () => performance.now(),
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      resume: { load: () => null, save: () => {} },
      nowPlaying: {
        setHandlers: setMediaSessionHandlers,
        commanded: () => {},
        show: (track, playing, position) =>
          showNowPlaying(
            track === null
              ? null
              : {
                  ...track,
                  artUrl: track.artUrl === null ? null : `${baseUrl}${track.artUrl}`,
                },
            playing,
            position,
          ),
      },
    },
  );

  return { controller, queue };
};

type GuestPlayer = {
  readonly controller: PlaybackController;
  readonly state: ControllerSnapshot;
};

/** Plays only a share's supplied songs, with no settings, Connect, Jam, or catalog subscriptions. */
export const useGuestPlayer = (tracks: ReadonlyArray<GuestTrack>, baseUrl: string): GuestPlayer => {
  const platform = usePlatform();
  const [{ controller, queue }] = useState(() => createGuestPlayer(platform, tracks, baseUrl));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const stop = controller.start();
    controller.sync(queue.state());

    return () => {
      stop();
    };
  }, [controller, queue]);

  return { controller, state };
};

/** Ticks only the mounted seek control, independently of the share's song list and artwork. */
export const useGuestPosition = (controller: PlaybackController): number => {
  const read = useCallback(() => controller.positionMs(), [controller]);

  return usePositionTicks(read);
};
