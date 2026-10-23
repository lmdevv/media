/**
 * Whether the connected server answers, for the session phase and for the screens that change
 * while it is out of reach (D11 to D14).
 */
import { useConvexConnectionState } from "convex/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { reachOf } from "@/lib/server-reach";
import type { Reach, ServerReach } from "@/lib/server-reach";
import type { SettledPhase } from "@/lib/session-phase";

/** How long a remembered server may stay silent at launch before G05 offers a way out. */
export const SILENT_AFTER_MS = 8000;

/**
 * How long a remembered server may stay silent before the app opens on the downloads (D11), or
 * shows that it lost the server (D14). Shorter than G05's wait: the downloads play either way.
 */
export const OFFLINE_AFTER_MS = 2500;

/** Whether the WebSocket has been down for `afterMs` while the app waits on it. */
export const useSilentServer = (afterMs: number = SILENT_AFTER_MS): boolean => {
  const { isWebSocketConnected } = useConvexConnectionState();
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    setSilent(false);

    if (isWebSocketConnected) return undefined;

    const timer = setTimeout(() => setSilent(true), afterMs);

    return () => clearTimeout(timer);
  }, [isWebSocketConnected, afterMs]);

  return silent;
};

/**
 * How long the connection may be down, or a request unanswered, before the app says it lost the
 * server (G04): a blip or a return from the background recovers sooner, without a flash.
 */
const RECONNECTING_AFTER_MS = 5000;

/** Whether `waiting` has held for `RECONNECTING_AFTER_MS`. */
const useLate = (waiting: boolean): boolean => {
  const [late, setLate] = useState(false);

  useEffect(() => {
    setLate(false);

    if (!waiting) return undefined;

    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);

    return () => clearTimeout(timer);
  }, [waiting]);

  return late;
};

const ServerReachContext = createContext<Reach | null>(null);

/**
 * Works out, once for every screen below it, whether the server answers: `phase` is the phase on
 * show, offline when the app opened without the server.
 */
export function ServerReachProvider({
  phase,
  children,
}: {
  readonly phase: SettledPhase["kind"];
  readonly children: ReactNode;
}) {
  const { isWebSocketConnected, hasEverConnected, hasInflightRequests } =
    useConvexConnectionState();

  const socketLost = useLate(!isWebSocketConnected) && hasEverConnected;
  const stalled = useLate(!isWebSocketConnected || hasInflightRequests) && hasEverConnected;
  const offlinePhase = phase === "offline";

  const value = useMemo(
    () => reachOf({ offlinePhase, socketLost, stalled }),
    [offlinePhase, socketLost, stalled],
  );

  return <ServerReachContext value={value}>{children}</ServerReachContext>;
}

const useReach = (hook: string): Reach => {
  const reach = useContext(ServerReachContext);

  if (reach === null) throw new Error(`${hook} needs ServerReachProvider above it`);

  return reach;
};

/**
 * Whether the server answers, for the screens that change while it doesn't. A slow request alone
 * doesn't count: a busy server, such as one mid-scan, still answers.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useServerReach = (): ServerReach => useReach("useServerReach").reach;

/**
 * Whether the server answers, as the notice says it: also reconnecting once a request has waited
 * past the grace, which is how a dead server with an open socket shows first.
 *
 * @throws When used outside `ServerReachProvider`, a programming error.
 */
export const useNoticeReach = (): ServerReach => useReach("useNoticeReach").notice;
