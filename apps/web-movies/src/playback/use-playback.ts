import { usePlatform } from "@media/sdk/react";
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";

import { MEDIA_BASE_URL } from "@/env";
import { useMediaServer } from "@/session/error-reporting";

import { browserMediaSupport } from "./browser-support";
import { detectCapabilities } from "./capabilities";
import type { MediaElementPlayer } from "./media-element-player";
import { PlaybackController } from "./playback-controller";
import type { PlaybackRequest, PlaybackServices, PlaybackSnapshot } from "./playback-controller";
import { usesHlsJs } from "./stream-attachment";

/** A controller and its latest state. */
export interface PlaybackHandle {
  readonly controller: PlaybackController;
  readonly snapshot: PlaybackSnapshot;
}

const subscribeNothing = (): (() => void) => () => undefined;

/**
 * Plays the request `buildRequest` makes in `element` as the signed-in person, disposing the
 * controller (and reporting where playback stopped) when the element, the platform client, or
 * `key` changes, or on unmount. `key` names the request: a new key starts a new playback, and only
 * then is the request built, from the latest render. Pass `null` while there is nothing to play;
 * passing a request again starts playback.
 */
export const usePlayback = (
  element: HTMLVideoElement | null,
  buildRequest: (() => PlaybackRequest) | null,
  key: string,
): PlaybackHandle | null => {
  const platform = usePlatform();
  const server = useMediaServer();

  const services = useMemo(
    (): PlaybackServices => ({
      play: { start: platform.movies.play.start, report: platform.movies.play.report },
      mediaBaseUrl: MEDIA_BASE_URL,
      sendDiagnostics: server.reportClientEvents,
    }),
    [platform, server],
  );

  const [controller, setController] = useState<PlaybackController | null>(null);
  const currentRequest = useEffectEvent(() => (buildRequest === null ? null : buildRequest()));
  const ready = buildRequest !== null;

  useEffect(() => {
    const started = currentRequest();

    if (element === null || started === null) return undefined;

    const capabilities = detectCapabilities(browserMediaSupport());

    const created = new PlaybackController(
      services,
      element,
      capabilities,
      usesHlsJs(capabilities.mse),
      started,
    );

    setController(created);
    void created.start();

    return () => {
      created.dispose();
      setController(null);
    };
  }, [services, element, key, ready]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    () => controller?.getSnapshot() ?? null,
  );

  return useMemo(
    () => (controller === null || snapshot === null ? null : { controller, snapshot }),
    [controller, snapshot],
  );
};

/** The element's state as the controls draw it. */
export interface MediaState {
  /** Where playback is, holding a seek's target until it lands. */
  readonly positionSeconds: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly buffering: boolean;
  /** Seconds buffered ahead of the position. */
  readonly bufferedAheadSeconds: number;
  readonly volume: number;
  readonly muted: boolean;
}

const MEDIA_EVENTS = [
  "timeupdate",
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "progress",
  "volumechange",
  "ended",
  "loadeddata",
  "emptied",
] as const;

const IDLE: MediaState = {
  positionSeconds: 0,
  paused: true,
  ended: false,
  buffering: false,
  bufferedAheadSeconds: 0,
  volume: 1,
  muted: false,
};

const bufferedAhead = (element: HTMLVideoElement): number => {
  const now = element.currentTime;
  const { buffered } = element;

  const range = Array.from({ length: buffered.length }, (_, index) => index).find(
    (index) => buffered.start(index) - 0.5 <= now && now <= buffered.end(index),
  );

  return range === undefined ? 0 : Math.max(0, buffered.end(range) - now);
};

const sameState = (left: MediaState, right: MediaState): boolean =>
  Math.abs(left.positionSeconds - right.positionSeconds) < 0.05 &&
  left.paused === right.paused &&
  left.ended === right.ended &&
  left.buffering === right.buffering &&
  Math.abs(left.bufferedAheadSeconds - right.bufferedAheadSeconds) < 0.5 &&
  left.volume === right.volume &&
  left.muted === right.muted;

/** Follows `element` through `player`, re-rendering on its media events. */
export const useMediaState = (
  element: HTMLVideoElement | null,
  player: MediaElementPlayer | null,
): MediaState => {
  const store = useMemo(() => {
    let current = IDLE;

    const read = (): MediaState => {
      if (element === null || player === null) return IDLE;

      const next: MediaState = {
        positionSeconds: player.positionMs() / 1000,
        paused: element.paused,
        ended: element.ended,
        buffering: player.isBuffering(),
        bufferedAheadSeconds: bufferedAhead(element),
        volume: element.volume,
        muted: element.muted,
      };

      if (!sameState(current, next)) current = next;

      return current;
    };

    const subscribe = (onChange: () => void): (() => void) => {
      if (element === null || player === null) return () => undefined;

      for (const type of MEDIA_EVENTS) element.addEventListener(type, onChange);

      const unsubscribe = player.subscribe(onChange);

      return () => {
        for (const type of MEDIA_EVENTS) element.removeEventListener(type, onChange);
        unsubscribe();
      };
    };

    return { read, subscribe };
  }, [element, player]);

  return useSyncExternalStore(store.subscribe, store.read, store.read);
};
