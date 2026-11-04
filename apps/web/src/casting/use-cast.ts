import { useMoviesRuntime } from "@media/sdk/react";
import { Result } from "effect";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";

import type { PlaybackController } from "@/playback/playback-controller";

import type { CastContext } from "./cast-api";
import type { RemoteState } from "./cast-player";
import { CastPlayback } from "./cast-playback";
import type { CastFailure } from "./cast-playback";
import type { CastItem } from "./cast-profile";
import { loadCastSdk } from "./cast-sdk";
import type { CastSdk } from "./cast-sdk";

type CastState = "NO_DEVICES_AVAILABLE" | "NOT_CONNECTED" | "CONNECTING" | "CONNECTED";

const CAST_STATES: ReadonlySet<string> = new Set([
  "NO_DEVICES_AVAILABLE",
  "NOT_CONNECTED",
  "CONNECTING",
  "CONNECTED",
]);

const isCastState = (state: string): state is CastState => CAST_STATES.has(state);

const FAILURES: Readonly<Record<CastFailure, string>> = {
  unsupported: "This can't play on that device",
  "load-failed": "The device couldn't load this",
  "not-ready": "Start playing first, then cast",
};

/** Chromecast as the player uses it. */
export interface Chromecast {
  /** Casting works in this browser and a device is on the network, or one is connected. */
  readonly available: boolean;
  /** Chrome is connecting to a device; this cannot be cancelled from the page. */
  readonly connecting: boolean;
  /** Connected, and the stream is being negotiated and loaded on the device. */
  readonly starting: boolean;
  /** The cast playing now, with its device and its player, or null. */
  readonly playback: CastPlayback | null;
  /** Opens Chrome's device picker. */
  readonly connect: () => void;
  /** Ends the cast and continues on the page. */
  readonly disconnect: () => void;
}

const NONE = (): (() => void) => () => undefined;

const useCastState = (sdk: CastSdk | null, context: CastContext | null): CastState => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (sdk === null || context === null) return () => undefined;
      const type = sdk.framework.CastContextEventType.CAST_STATE_CHANGED;

      context.addEventListener(type, onChange);

      return () => context.removeEventListener(type, onChange);
    },
    [sdk, context],
  );

  const read = (): CastState => {
    const state = context?.getCastState() ?? "NO_DEVICES_AVAILABLE";

    return isCastState(state) ? state : "NO_DEVICES_AVAILABLE";
  };

  return useSyncExternalStore(sdk === null ? NONE : subscribe, read, read);
};

/**
 * Chromecast for `controller`'s session. Casting starts once the controller has played (`ready`),
 * showing `item` on the TV.
 */
export const useCast = (
  controller: PlaybackController | null,
  ready: boolean,
  item: CastItem | null,
): Chromecast => {
  const runtime = useMoviesRuntime();
  const [sdk, setSdk] = useState<CastSdk | null>(null);
  const [playback, setPlayback] = useState<CastPlayback | null>(null);
  const [starting, setStarting] = useState(false);
  const [readyFor, setReadyFor] = useState<PlaybackController | null>(null);

  if (ready && controller !== null && readyFor !== controller) setReadyFor(controller);

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      const loaded = await loadCastSdk();

      if (!active || loaded === null) return;
      loaded.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: loaded.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: loaded.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      setSdk(loaded);
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  const context = sdk?.framework.CastContext.getInstance() ?? null;
  const state = useCastState(sdk, context);
  const stateRef = useRef(state);
  const itemRef = useRef(item);

  // Layout effects run before passive cleanups, so the casting effect's cleanup reads this
  // render's state when it decides whether a disconnect ended the cast.
  useLayoutEffect(() => {
    stateRef.current = state;
    itemRef.current = item;
  });

  const connected = state === "CONNECTED";
  const castable = readyFor !== null && readyFor === controller ? controller : null;

  useEffect(() => {
    const cast = itemRef.current;
    const session = context?.getCurrentSession() ?? null;

    if (!connected || sdk === null || castable === null || cast === null || session === null) {
      return undefined;
    }

    let current: CastPlayback | null = null;
    let cancelled = false;

    const end = (playing: CastPlayback): void => {
      const disconnected = stateRef.current !== "CONNECTED";

      playing.stop(disconnected);

      if (!disconnected) playing.player.stopReceiver();
    };

    setStarting(true);

    const start = async (): Promise<void> => {
      const result = await CastPlayback.start(runtime, sdk, session, castable, cast, (message) => {
        toast.error(message);
        context?.endCurrentSession(true);
      });

      if (cancelled) {
        if (Result.isSuccess(result)) end(result.success);

        return;
      }

      setStarting(false);

      if (Result.isFailure(result)) {
        toast.error(FAILURES[result.failure]);
        context?.endCurrentSession(true);

        return;
      }

      current = result.success;
      setPlayback(current);
    };

    void start();

    return () => {
      cancelled = true;
      setStarting(false);
      setPlayback(null);

      if (current !== null) end(current);
    };
  }, [connected, sdk, context, castable, runtime]);

  const connect = useCallback(() => {
    void context?.requestSession().catch(() => undefined);
  }, [context]);

  const disconnect = useCallback(() => {
    context?.endCurrentSession(true);
  }, [context]);

  return {
    available: sdk !== null && state !== "NO_DEVICES_AVAILABLE",
    connecting: state === "CONNECTING",
    starting,
    playback,
    connect,
    disconnect,
  };
};

const NO_STATE = (): null => null;

/** The receiver's state while `playback` casts, following its changes; null otherwise. */
export const useRemoteState = (playback: CastPlayback | null): RemoteState | null =>
  useSyncExternalStore(
    playback?.player.watch ?? NONE,
    playback === null ? NO_STATE : playback.player.getState,
    playback === null ? NO_STATE : playback.player.getState,
  );
