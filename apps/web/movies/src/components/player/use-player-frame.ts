import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const CONTROLS_IDLE_MS = 3_000;

/**
 * Whether the controls show: always while `hold` is set (paused, a panel open), otherwise until
 * the viewer has been idle over `frame` for three seconds.
 */
export const useControlsVisible = (frame: HTMLElement | null, hold: boolean): boolean => {
  const [awake, setAwake] = useState(true);

  useEffect(() => {
    if (frame === null) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const wake = (): void => {
      setAwake(true);
      clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), CONTROLS_IDLE_MS);
    };

    wake();
    frame.addEventListener("pointermove", wake);
    frame.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);

    return () => {
      clearTimeout(timer);
      frame.removeEventListener("pointermove", wake);
      frame.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [frame]);

  return hold || awake;
};

/** Full screen as the player uses it. */
export interface Fullscreen {
  /** Enters or leaves full screen. */
  readonly toggle: () => void;
  /**
   * Takes an Escape press that belongs to full screen: one pressed while full screen, which leaves
   * it if the browser has not already, or one pressed before full screen ended but delivered after
   * (event times, not a window, tell them apart). Returns whether the press was taken, so nothing
   * else acts on it.
   */
  readonly takeEscape: (event: KeyboardEvent) => boolean;
}

/** The toggle for full screen on `frame` (or the video on iPhones), and Escape's part in it. */
export const useFullscreen = (
  frame: HTMLElement | null,
  video: HTMLVideoElement | null,
): Fullscreen => {
  const endedAt = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const onChange = (event: Event): void => {
      if (document.fullscreenElement === null) endedAt.current = event.timeStamp;
    };

    document.addEventListener("fullscreenchange", onChange);

    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);

      return;
    }

    // iPhone Safari offers no element full screen, only the system player.
    if (frame !== null && document.fullscreenEnabled) {
      void frame.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());

      return;
    }

    video?.webkitEnterFullscreen?.();
  }, [frame, video]);

  const takeEscape = useCallback((event: KeyboardEvent): boolean => {
    if (document.fullscreenElement !== null) {
      // The browser may be leaving already for this same press; then this call is refused.
      void document.exitFullscreen().catch(() => undefined);

      return true;
    }

    return event.timeStamp <= endedAt.current;
  }, []);

  return { toggle, takeEscape };
};

const PHONE_QUERY = "(pointer: coarse) and ((width < 48rem) or (height < 30rem))";

const PORTRAIT_QUERY = "(orientation: portrait)";

const subscribeLayout = (onChange: () => void): (() => void) => {
  const queries = [window.matchMedia(PHONE_QUERY), window.matchMedia(PORTRAIT_QUERY)];

  for (const query of queries) query.addEventListener("change", onChange);

  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
};

/** Which player layout fits this screen. */
export type PlayerLayout = "desktop" | "phone-landscape" | "phone-portrait";

const readLayout = (): PlayerLayout => {
  if (!window.matchMedia(PHONE_QUERY).matches) return "desktop";

  return window.matchMedia(PORTRAIT_QUERY).matches ? "phone-portrait" : "phone-landscape";
};

/** The player layout for this screen, following rotation. */
export const usePlayerLayout = (): PlayerLayout =>
  useSyncExternalStore(subscribeLayout, readLayout, readLayout);
