import {
  CLOCK_SAMPLING,
  HEARTBEAT_MS,
  estimateClockOffset,
  toServerTime,
} from "@media/contracts/clock";
import type { ClockSample } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { MOVIES } from "./session";
import type { SessionView } from "./session";

/** The person's movies session: undefined while it loads, null outside one. */
type CurrentSession = SessionView | undefined;

const CurrentSessionContext = createContext<CurrentSession>(undefined);

/** The server's time now, as heartbeats estimate it, or the device's until one has answered. */
type ServerNow = () => EpochMillis;

const deviceNow: ServerNow = () => EpochMillis.make(Date.now());

const ServerNowContext = createContext<ServerNow>(deviceNow);

/** Whether the person holds a place that heartbeats keep: in a live session, or waiting for one. */
const keepsPlace = (view: CurrentSession): boolean =>
  view?.state === "joined" || view?.state === "pending";

/**
 * Reads the person's movies session for everything inside, and keeps them present in it with a
 * heartbeat every `HEARTBEAT_MS` on any screen, so browsing elsewhere in the app keeps their seat
 * and, for the host, keeps the session playing (ADR 0017). Closing every tab stops the heartbeats:
 * after 30 seconds the person counts as away, and a host away pauses the session.
 */
export function CurrentSessionProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const current = usePlatformQuery(platform.core.together.get, { domain: MOVIES });
  const view: CurrentSession = current.status === "success" ? current.data : undefined;
  const beating = keepsPlace(view);
  const sessionId = view?.sessionId ?? null;
  const samples = useRef<ReadonlyArray<ClockSample>>([]);

  useEffect(() => {
    if (!beating || sessionId === null) return undefined;

    const beat = (): void => {
      const sentAt = Date.now();

      void platform.core.together.heartbeat({ domain: MOVIES }).then(
        ({ serverTime }) => {
          const sample: ClockSample = {
            sentAt,
            serverTime: EpochMillis.make(Math.round(serverTime)),
            receivedAt: Date.now(),
          };

          samples.current = [...samples.current, sample].slice(-CLOCK_SAMPLING.kept);

          return undefined;
        },
        () => undefined,
      );
    };

    beat();

    const timer = setInterval(beat, HEARTBEAT_MS);

    return () => clearInterval(timer);
  }, [platform, beating, sessionId]);

  const serverNow = useCallback((): EpochMillis => {
    const offset = estimateClockOffset(samples.current);

    return offset === undefined ? deviceNow() : toServerTime(Date.now(), offset);
  }, []);

  return (
    <CurrentSessionContext value={view}>
      <ServerNowContext value={serverNow}>{children}</ServerNowContext>
    </CurrentSessionContext>
  );
}

/** The person's movies session inside `CurrentSessionProvider`: undefined while it loads. */
export const useCurrentSession = (): CurrentSession => useContext(CurrentSessionContext);

/**
 * The server's time now inside `CurrentSessionProvider`, estimated from the session's heartbeats
 * as the follower estimates it, so a screen places the shared clock before its player follows.
 */
export const useServerNow = (): ServerNow => useContext(ServerNowContext);
