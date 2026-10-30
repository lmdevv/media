/**
 * Selecting the Search tab opens its field with the keyboard up (A13, A17 · 03), as Apple Music
 * does: the tab bar becomes the search field and searching starts at once. The tab bar reports the
 * selection here and the Search screen focuses its field, so the field's close circle leaves the
 * results on screen rather than returning to the previous tab, as UISearchTab's own activation
 * does. On an iPad the sidebar's Search row asks instead, and may do so before the Search tab has
 * ever mounted, so its request waits, and the screen's field opens focused.
 */
import { useIsFocused } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

/** How often, and how many times, a focus waiting for the field is tried. */
const FOCUS_RETRY_MS = 100;

const FOCUS_TRIES = 20;

interface SearchActivation {
  /** Asks the Search screen to focus its field. */
  readonly activate: () => void;
  /** Asks the same, or with no Search screen yet, leaves the request for it to take. */
  readonly request: () => void;
  /** Whether a request is waiting, and clears it. */
  readonly takeRequest: () => boolean;
  /** Sets what requesting does; returns the cleanup that unsets it. */
  readonly onRequest: (next: () => void) => () => void;
  /** Sets what activating does; returns the cleanup that unsets it. */
  readonly onActivate: (focus: () => void) => () => void;
}

const SearchActivationContext = createContext<SearchActivation | null>(null);

/** Shares the Search tab's activation between the tab bar and the Search screen. */
export function SearchActivationProvider({ children }: { readonly children: ReactNode }) {
  const focus = useRef<(() => void) | null>(null);
  const requested = useRef<(() => void) | null>(null);
  const waiting = useRef(false);

  const value = useMemo<SearchActivation>(
    () => ({
      activate: () => focus.current?.(),
      request: () => {
        if (requested.current === null) waiting.current = true;
        else requested.current();
      },
      takeRequest: () => {
        const taken = waiting.current;

        waiting.current = false;

        return taken;
      },
      onRequest: (next) => {
        requested.current = next;

        return () => {
          if (requested.current === next) requested.current = null;
        };
      },
      onActivate: (next) => {
        focus.current = next;

        return () => {
          if (focus.current === next) focus.current = null;
        };
      },
    }),
    [],
  );

  return <SearchActivationContext value={value}>{children}</SearchActivationContext>;
}

const useSearchActivation = (): SearchActivation => {
  const activation = useContext(SearchActivationContext);

  if (activation === null) throw new Error("SearchActivationProvider is missing above this screen");

  return activation;
};

/** The tab bar's side: call the result when the Search tab is selected. */
export const useActivateSearch = (): (() => void) => useSearchActivation().activate;

/** The iPad sidebar's side: call the result on the way to the Search tab. */
export const useRequestSearch = (): (() => void) => useSearchActivation().request;

/**
 * The Search screen's side of `request`: while the screen is on show, keeps asking `focus` until
 * `fieldFocused`. The Search tab may only be on its way to the screen, and UIKit attaches the
 * header's field some frames after the screen mounts; it says nothing when it has, and ignores a
 * focus before then. Leaving the screen drops the request.
 */
export const useFocusOnRequest = (focus: () => void, fieldFocused: boolean): void => {
  const { takeRequest, onRequest } = useSearchActivation();
  const onShow = useIsFocused();
  const [wasOnShow, setWasOnShow] = useState(onShow);
  const [requested, setRequested] = useState(takeRequest);
  const asking = requested && onShow && !fieldFocused;

  if (requested && fieldFocused) setRequested(false);

  if (onShow !== wasOnShow) {
    setWasOnShow(onShow);

    if (!onShow) setRequested(false);
  }

  useEffect(() => onRequest(() => setRequested(true)), [onRequest]);

  useEffect(() => {
    if (!asking) return undefined;

    let tries = 0;

    const timer = setInterval(() => {
      tries += 1;
      focus();

      if (tries >= FOCUS_TRIES) setRequested(false);
    }, FOCUS_RETRY_MS);

    return () => clearInterval(timer);
  }, [asking, focus]);
};

/** The Search screen's side: runs `focus` each time the Search tab is selected. */
export const useOnSearchActivate = (focus: () => void): void => {
  const { onActivate } = useSearchActivation();

  useEffect(() => onActivate(focus), [onActivate, focus]);
};
