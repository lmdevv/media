import { useSyncExternalStore } from "react";

const DESKTOP = "(min-width: 1024px)";

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
};

/** True at the desktop layout width (the `lg` breakpoint), where the sidebar shell is shown. */
export const useIsDesktop = (): boolean =>
  useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP).matches);
