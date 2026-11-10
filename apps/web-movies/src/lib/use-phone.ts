import { useSyncExternalStore } from "react";

const PHONE_QUERY = "(width < 48rem)";

const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(PHONE_QUERY);

  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
};

const read = (): boolean => window.matchMedia(PHONE_QUERY).matches;

/**
 * Whether the window is phone-sized, for the few places that render different components rather
 * than restyle the same ones (phone rows use landscape cards where desktops use posters).
 */
export const usePhone = (): boolean => useSyncExternalStore(subscribe, read, read);
