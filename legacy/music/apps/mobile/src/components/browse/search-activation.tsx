/**
 * Selecting the Search tab opens its field with the keyboard up (A13, A17 · 03), as Apple Music
 * does: the tab bar becomes the search field and searching starts at once. The tab bar reports the
 * selection here and the Search screen focuses its field, so the field's close circle leaves the
 * results on screen rather than returning to the previous tab, as UISearchTab's own activation
 * does.
 */
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

interface SearchActivation {
  /** Asks the Search screen to focus its field. */
  readonly activate: () => void;
  /** Sets what activating does; returns the cleanup that unsets it. */
  readonly onActivate: (focus: () => void) => () => void;
}

const SearchActivationContext = createContext<SearchActivation | null>(null);

/** Shares the Search tab's activation between the tab bar and the Search screen. */
export function SearchActivationProvider({ children }: { readonly children: ReactNode }) {
  const focus = useRef<(() => void) | null>(null);

  const value = useMemo<SearchActivation>(
    () => ({
      activate: () => focus.current?.(),
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

/** The Search screen's side: runs `focus` each time the Search tab is selected. */
export const useOnSearchActivate = (focus: () => void): void => {
  const { onActivate } = useSearchActivation();

  useEffect(() => onActivate(focus), [onActivate, focus]);
};
