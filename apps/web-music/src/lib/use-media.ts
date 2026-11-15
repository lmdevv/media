import { useSyncExternalStore } from "react";

const DESKTOP = "(min-width: 1024px)";

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
};

/** Whether the window is at the desktop layout width now, for event handlers. */
export const isDesktopNow = (): boolean => window.matchMedia(DESKTOP).matches;

/** True at the desktop layout width (the `lg` breakpoint), where the sidebar shell is shown. */
export const useIsDesktop = (): boolean => useSyncExternalStore(subscribe, isDesktopNow);
