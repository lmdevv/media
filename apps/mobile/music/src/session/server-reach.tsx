import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Option } from "effect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";

import { useDownloadsReach, useTrackHeld } from "@/downloads";
import { reachOf } from "@/lib/server-reach";
import type { Observation, Reach, ServerReach } from "@/lib/server-reach";
import type { SettledPhase } from "@/lib/session-phase";
import { reachWatch } from "@/session/reach-watch";
import type { ReachWatch } from "@/session/reach-watch";
import { useServerHealth } from "@/session/sdk-provider";

interface ReachState extends Reach {
  readonly check: () => Promise<boolean>;
  readonly hear: (observation: Observation) => void;
  /** Tells whether this phone plays the server's queue, which needs the server in the background. */
  readonly setPlaying: (playing: boolean) => void;
}

const ServerReachContext = createContext<ReachState | null>(null);

const noWatch = (): (() => void) => () => undefined;

/**
 * The connection's `ReachWatch`, fed by the core's socket, by the core's word that the media
 * server went away, by whether the app is on screen, and by whether the server's queue plays here.
 * It checks the server's health on coming back on screen, with the read that also follows the
 * server's release. The watch belongs to this connection, and closes with it.
 */
const useWatch = (playing: boolean): ReachWatch | null => {
  const platform = usePlatform();
  const readHealth = useServerHealth();
  const [watch, setWatch] = useState<ReachWatch | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const presence = usePlatformQuery(platform.core.server.presence);
  const away = presence.status === "success" && presence.data === "away";

  useEffect(() => {
    const made = reachWatch(async () => Option.isSome(await readHealth()));
    const stopConnection = platform.onConnection(made.connection);

    const foregrounding = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");

      if (state === "active") void made.check();
    });

    setWatch(made);

    return () => {
      foregrounding.remove();
      void stopConnection();
      made.close();
    };
  }, [platform, readHealth]);

  useEffect(() => {
    watch?.need(foreground || playing);
  }, [watch, foreground, playing]);

  // Pushed over the socket the app holds anyway, only when it changes.
  useEffect(() => {
    if (away) watch?.hear("doubted");
  }, [watch, away]);

  return watch;
};

/**
 * Works out, once for every screen below it, whether the server answers: `phase` is the phase on
 * show, offline when the app opened without the server. Tells the downloads, which fetch only
 * while it answers. The core's socket stands for the core, and the core says when the media
 * server stops beating; a health check of the media server decides each doubt.
 */
export function ServerReachProvider({
  phase,
  children,
}: {
  readonly phase: SettledPhase["kind"];
  readonly children: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const watch = useWatch(playing);
  const lost = useSyncExternalStore(watch?.subscribe ?? noWatch, () => watch?.lost() ?? false);
  const latest = useRef(watch);
  const offlinePhase = phase === "offline";

  useEffect(() => {
    latest.current = watch;
  }, [watch]);

  const check = useCallback(async () => (await latest.current?.check()) ?? false, []);

  const hear = useCallback((observation: Observation) => {
    latest.current?.hear(observation);
  }, []);

  const value = useMemo(
    () => ({
      ...reachOf({ offlinePhase, socketLost: lost, stalled: false }),
      check,
      hear,
      setPlaying,
    }),
    [offlinePhase, lost, check, hear],
  );

  useDownloadsReach(value.reach === "online" && phase === "ready");

  return <ServerReachContext value={value}>{children}</ServerReachContext>;
}

const useReach = (hook: string): ReachState => {
  const reach = useContext(ServerReachContext);

  if (reach === null) throw new Error(`${hook} needs ServerReachProvider above it`);

  return reach;
};

/**
 * Whether the server answers, for the screens that change while it doesn't.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useServerReach = (): ServerReach => useReach("useServerReach").reach;

/**
 * Whether the server answers, as the notice says it.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useNoticeReach = (): ServerReach => useReach("useNoticeReach").notice;

/**
 * Checks the server's health now, as the player does when a command goes unanswered; resolves
 * whether it answered.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useCheckReach = (): (() => Promise<boolean>) => useReach("useCheckReach").check;

/**
 * Takes in what one of the player's requests said of the server, such as a stream that failed.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useHearReach = (): ((observation: Observation) => void) =>
  useReach("useHearReach").hear;

/**
 * Keeps the server watched in the background while `playing` the server's queue: iOS keeps the
 * app running while it plays audio, and a server lost then (leaving home Wi-Fi with the phone in a
 * pocket) moves the player to the downloaded songs before it reaches one it can't stream. While it
 * plays its own downloaded songs instead, nothing needs the server and nothing is sent.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useReachWhilePlaying = (playing: boolean): void => {
  const { setPlaying } = useReach("useReachWhilePlaying");

  useEffect(() => {
    setPlaying(playing);

    return () => {
      setPlaying(false);
    };
  }, [setPlaying, playing]);
};

/**
 * Whether a song can play now: always while the server answers, else only when this phone holds
 * it; never offline for a row that isn't a real track. Rows of songs it can't play dim, and say
 * "Not downloaded" (D13).
 */
export const useTrackReachable = (trackId: Parameters<typeof useTrackHeld>[0]): boolean => {
  const online = useServerReach() === "online";
  const held = useTrackHeld(trackId);

  return online || held;
};
