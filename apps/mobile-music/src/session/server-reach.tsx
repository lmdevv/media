import { readHealth } from "@media/mobile-core/server";
import { Option } from "effect";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";

import { useDownloadsReach, useTrackHeld } from "@/downloads";
import { probesReach, reachOf } from "@/lib/server-reach";
import type { Reach, ServerReach } from "@/lib/server-reach";
import type { SettledPhase } from "@/lib/session-phase";
import { useServer } from "@/session/connection";

const ONLINE_PROBE_MS = 10_000;

/** How often it is asked while it does not, so the app notices it back soon. */
const LOST_PROBE_MS = 3000;

const LOST_AFTER = 2;

interface ReachState extends Reach {
  readonly probe: () => void;
  /** Tells whether this phone plays audio, which keeps the checks going in the background. */
  readonly setAudible: (audible: boolean) => void;
}

const ServerReachContext = createContext<ReachState | null>(null);

interface Lost {
  readonly lost: boolean;
  readonly probe: () => void;
}

/**
 * Whether the media server answers its health check, asked on a timer while the app is on screen
 * or plays audio in the background, and at once when it comes back. The platform client keeps its
 * own connection and does not say how it stands; on an install the media server and the core run
 * in one place, so the media server answering stands for both.
 */
const useLost = (mediaUrl: string, audible: boolean): Lost => {
  const [failures, setFailures] = useState(0);
  const [asked, setAsked] = useState(0);
  const [active, setActive] = useState(AppState.currentState === "active");
  const lost = failures >= LOST_AFTER;
  const watching = probesReach({ active, audible });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!watching) return undefined;
    const stop = new AbortController();

    const ask = async (): Promise<void> => {
      const health = await readHealth(mediaUrl);

      if (stop.signal.aborted) return;
      setFailures((count) => (Option.isSome(health) ? 0 : count + 1));
    };

    void ask();
    const timer = setInterval(() => void ask(), lost ? LOST_PROBE_MS : ONLINE_PROBE_MS);

    return () => {
      stop.abort();
      clearInterval(timer);
    };
    // `active` too, so the app asks at once when it comes back on screen.
  }, [mediaUrl, watching, active, lost, asked]);

  const probe = useCallback(() => {
    setAsked((count) => count + 1);
  }, []);

  return { lost, probe };
};

/**
 * Works out, once for every screen below it, whether the server answers: `phase` is the phase on
 * show, offline when the app opened without the server. Tells the downloads, which fetch only
 * while it answers.
 */
export function ServerReachProvider({
  phase,
  children,
}: {
  readonly phase: SettledPhase["kind"];
  readonly children: ReactNode;
}) {
  const { mediaUrl } = useServer();
  const [audible, setAudible] = useState(false);
  const { lost, probe } = useLost(mediaUrl, audible);
  const offlinePhase = phase === "offline";

  const value = useMemo(
    () => ({ ...reachOf({ offlinePhase, socketLost: lost, stalled: false }), probe, setAudible }),
    [offlinePhase, lost, probe],
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

/** Asks the server now whether it answers, as the player does when a command goes unanswered. */
export const useProbeReach = (): (() => void) => useReach("useProbeReach").probe;

/**
 * Keeps asking whether the server answers while `audible`, in the background too: iOS keeps the
 * app running while it plays audio, and a server lost then (leaving home Wi-Fi with the phone in a
 * pocket) moves the player to the downloaded songs before it reaches one it can't stream.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useReachWhileAudible = (audible: boolean): void => {
  const { setAudible } = useReach("useReachWhileAudible");

  useEffect(() => {
    setAudible(audible);

    return () => {
      setAudible(false);
    };
  }, [setAudible, audible]);
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
