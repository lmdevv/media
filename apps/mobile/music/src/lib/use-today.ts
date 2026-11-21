import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { dayClock } from "./day-clock";

const clock = dayClock(() => Date.now());

const subscribe = (listener: () => void): (() => void) => {
  const stop = clock.subscribe(listener);

  // A suspended app's timers don't fire, so midnight may pass while it is in the background.
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") clock.refresh();
  });

  return () => {
    foreground.remove();
    stop();
  };
};

/** The start of the current local day, which changes at midnight and when the app comes back. */
export const useToday = (): number => useSyncExternalStore(subscribe, clock.read, clock.read);
