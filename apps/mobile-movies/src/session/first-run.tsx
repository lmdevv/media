import { router } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { SessionPhase } from "./session-phase";

/** Where setup goes once the owner account exists: Add Your First Library, or an import. */
export type SetupStart = "library" | "import";

interface FirstRun {
  readonly active: boolean;
  readonly start: SetupStart;
  readonly begin: (start: SetupStart) => void;
  readonly startedImport: () => void;
  readonly end: () => void;
}

const FirstRunContext = createContext<FirstRun | null>(null);

/** Holds whether owner setup is under way. */
export function FirstRunProvider({ children }: { readonly children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [start, setStart] = useState<SetupStart>("library");

  const value = useMemo(
    (): FirstRun => ({
      active,
      start,
      begin: (next) => {
        setStart(next);
        setActive(true);
      },
      startedImport: () => setStart("library"),
      end: () => setActive(false),
    }),
    [active, start],
  );

  return <FirstRunContext.Provider value={value}>{children}</FirstRunContext.Provider>;
}

/**
 * Owner setup on this device.
 *
 * @throws When used outside `FirstRunProvider`, a programming error.
 */
export const useFirstRun = (): FirstRun => {
  const firstRun = useContext(FirstRunContext);

  if (firstRun === null) throw new Error("useFirstRun must be used inside FirstRunProvider");

  return firstRun;
};

/**
 * Goes Home when owner setup ends. The owner screens stay allowed once the app is ready, so the
 * stack would otherwise keep showing them instead of moving to Home by itself.
 */
export const useHomeAfterSetup = (phase: SessionPhase["kind"] | "offline"): void => {
  const previous = useRef(phase);

  useEffect(() => {
    if (previous.current === "setup" && phase === "ready") router.replace("/");

    previous.current = phase;
  }, [phase]);
};
