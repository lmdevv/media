import { HEARTBEAT_MS } from "@media/contracts/clock";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";

import { MOVIES } from "@/lib/together/session";
import type { SessionView } from "@/lib/together/session";

/** The person's movies session: undefined while it loads, null outside one. */
type CurrentSession = SessionView | undefined;

const CurrentSessionContext = createContext<CurrentSession>(undefined);

const useForeground = (): boolean => {
  const [active, setActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      setActive(status === "active");
    });

    return () => subscription.remove();
  }, []);

  return active;
};

/**
 * Reads the person's movies session for the app, and keeps them present in it with a heartbeat
 * every `HEARTBEAT_MS` while the app is in the foreground (ADR 0017). Leaving the app stops them:
 * after 30 seconds the person counts as away, and a host away pauses the session.
 */
export function CurrentSessionProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const current = usePlatformQuery(platform.core.together.get, { domain: MOVIES });
  const view: CurrentSession = current.status === "success" ? current.data : undefined;
  const beating = view?.state === "joined" || view?.state === "pending";
  const sessionId = view?.sessionId ?? null;
  const foreground = useForeground();

  useEffect(() => {
    if (!beating || !foreground || sessionId === null) return undefined;

    const beat = (): void => {
      void platform.core.together.heartbeat({ domain: MOVIES }).catch(() => undefined);
    };

    beat();

    const timer = setInterval(beat, HEARTBEAT_MS);

    return () => clearInterval(timer);
  }, [platform, beating, foreground, sessionId]);

  return <CurrentSessionContext value={view}>{children}</CurrentSessionContext>;
}

/** The person's movies session inside `CurrentSessionProvider`: undefined while it loads. */
export const useCurrentSession = (): CurrentSession => useContext(CurrentSessionContext);
