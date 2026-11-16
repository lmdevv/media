/**
 * Chromecast for the music player: loads the Cast SDK in browsers that cast, follows whether a
 * device is around and connected, and while one is connected plays the queue through it
 * (`castTo`), so the song here moves to the TV and Connect shows the browser's output as the TV
 * (ADR 0018). Disconnecting, from this page or from the TV, brings the song back to the browser at
 * the place the TV reached.
 */
import { castMusicProfile } from "@media/contracts/cast";
import { TICKET_PARAM } from "@media/contracts/ticket";
import { usePlayer } from "@media/player/react";
import type { Player } from "@media/player/react";
import { Playback } from "@media/sdk/effect";
import { Effect, Exit, Redacted } from "effect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { useJoinedJam } from "@/components/jam/jam";
import { MEDIA_BASE_URL } from "@/env";

import type { CastContext } from "./cast-api";
import { CastEngine } from "./cast-engine";
import type { CastEngineHost, CastSong } from "./cast-engine";
import { loadCastSdk } from "./cast-sdk";
import type { CastSdk } from "./cast-sdk";

/** The SDK's cast states. */
type CastState = "NO_DEVICES_AVAILABLE" | "NOT_CONNECTED" | "CONNECTING" | "CONNECTED";

const CAST_STATES: ReadonlySet<string> = new Set([
  "NO_DEVICES_AVAILABLE",
  "NOT_CONNECTED",
  "CONNECTING",
  "CONNECTED",
]);

// SAFETY: a type predicate, checked against the list of states it narrows to.
const isCastState = (state: string): state is CastState => CAST_STATES.has(state);

/** How long a check of a stream the TV could not play waits for the media server's answer. */
const PROBE_TIMEOUT_MS = 5_000;

/** Chromecast as the music client uses it. */
export interface MusicCast {
  /** Casting works in this browser and a device is on the network, or one is connected. */
  readonly available: boolean;
  /** Chrome is connecting to a device; this cannot be cancelled from the page. */
  readonly connecting: boolean;
  /** The device the music plays on now, by its name, or null while nothing is connected. */
  readonly device: { readonly name: string | null } | null;
  /** Opens Chrome's device picker. */
  readonly connect: () => void;
  /** Ends the cast; the music comes back to this browser. */
  readonly disconnect: () => void;
}

const NONE: MusicCast = {
  available: false,
  connecting: false,
  device: null,
  connect: () => {},
  disconnect: () => {},
};

const CastContextValue = createContext<MusicCast>(NONE);

/** Chromecast for the music player; outside `CastProvider`, a browser that cannot cast. */
export const useCast = (): MusicCast => useContext(CastContextValue);

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** The cast state of `context`, following its changes. */
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

  return useSyncExternalStore(sdk === null ? NO_SUBSCRIPTION : subscribe, read, read);
};

/** The song `trackId` as the TV shows it, from the queue on screen. */
const songIn = (player: Player, trackId: string): CastSong | null => {
  const track = player.queue.find((queued) => queued.id === trackId);

  if (track === undefined) return null;

  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    artUrl: track.artUrl === null ? null : `${MEDIA_BASE_URL}${track.artUrl}`,
    codec: track.codec,
  };
};

/** Asks the media server for the receiver credential of the start whose stream is `streamUrl`. */
const lend = async (streamUrl: string): Promise<string | null> => {
  const ticket = URL.canParse(streamUrl) ? new URL(streamUrl).searchParams.get(TICKET_PARAM) : null;

  if (ticket === null) return null;

  const lent = await Effect.runPromiseExit(
    Playback.lendToReceiver({ mediaBaseUrl: MEDIA_BASE_URL, token: ticket }),
  );

  return Exit.isSuccess(lent) ? Redacted.value(lent.value) : null;
};

/** The status the media server answers this page for the first byte of `url`, or null. */
const probe = async (url: string): Promise<number | null> => {
  try {
    const response = await fetch(url, {
      headers: { range: "bytes=0-0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    void response.body?.cancel().catch(() => undefined);

    return response.status;
  } catch {
    return null;
  }
};

/**
 * Plays the queue through the Chromecast this browser connects to, and tells its children. A Jam
 * plays here and casts nowhere, as old music had no casting (ADR 0018): joining one ends the cast.
 */
export function CastProvider({ children }: { readonly children: ReactNode }) {
  const player = usePlayer();
  const [sdk, setSdk] = useState<CastSdk | null>(null);
  const latest = useRef(player);

  useLayoutEffect(() => {
    latest.current = player;
  });

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
  const connected = state === "CONNECTED";
  const [device, setDevice] = useState<{ readonly name: string | null } | null>(null);
  const inJam = useJoinedJam() !== null;

  // Chrome's own Cast menu can connect too, so this ends any cast while a Jam plays here.
  useEffect(() => {
    if (connected && inJam) context?.endCurrentSession(true);
  }, [connected, inJam, context]);

  useEffect(() => {
    const session = connected ? (context?.getCurrentSession() ?? null) : null;

    if (sdk === null || session === null) return undefined;

    const host: CastEngineHost = {
      song: (trackId) => songIn(latest.current, trackId),
      lend,
      probe,
    };

    const engine = new CastEngine(sdk, session, host);
    const name = engine.receiverName;

    // The player's actions change with every render; the latest one acts.
    latest.current.castTo({ engine, name, profileFor: (track) => castMusicProfile(track.codec) });
    setDevice({ name });

    return () => {
      latest.current.castTo(null);
      engine.dispose();
      setDevice(null);
    };
  }, [connected, sdk, context]);

  const value = useMemo(
    (): MusicCast => ({
      available: sdk !== null && state !== "NO_DEVICES_AVAILABLE",
      connecting: state === "CONNECTING",
      device,
      connect: () => {
        void context?.requestSession().catch(() => undefined);
      },
      disconnect: () => {
        context?.endCurrentSession(true);
      },
    }),
    [sdk, state, device, context],
  );

  return <CastContextValue.Provider value={value}>{children}</CastContextValue.Provider>;
}
