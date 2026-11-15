import { HEARTBEAT_MS } from "@media/contracts/clock";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";

import { MOVIES } from "./session";
import type { SessionView } from "./session";

/** The person's movies session: undefined while it loads, null outside one. */
type CurrentSession = SessionView | undefined;

const CurrentSessionContext = createContext<CurrentSession>(undefined);

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

  useEffect(() => {
    if (!beating || sessionId === null) return undefined;

    const beat = (): void => {
      void platform.core.together.heartbeat({ domain: MOVIES }).catch(() => undefined);
    };

    beat();

    const timer = setInterval(beat, HEARTBEAT_MS);

    return () => clearInterval(timer);
  }, [platform, beating, sessionId]);

  return <CurrentSessionContext value={view}>{children}</CurrentSessionContext>;
}

/** The person's movies session inside `CurrentSessionProvider`: undefined while it loads. */
export const useCurrentSession = (): CurrentSession => useContext(CurrentSessionContext);
