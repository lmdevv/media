/**
 * The browse lists' order and layout, shared by the lists and the Sort and view sheet (A12) and
 * kept on this device, so Albums opens the way it was left.
 */
import { useSyncExternalStore } from "react";

import { decodeView, encodeView } from "@/lib/browse-view";
import type { BrowseView } from "@/lib/browse-view";
import { readValue, writeValue } from "@/lib/secure-storage";

const KEY = "music.browse-view";

let view: BrowseView | null = null;

const listeners = new Set<() => void>();

const current = (): BrowseView => {
  view ??= decodeView(readValue(KEY));

  return view;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

/** The browse lists' order and layout, re-rendering when the sheet changes them. */
export const useBrowseView = (): BrowseView => useSyncExternalStore(subscribe, current);

/** Changes the order or layout of the browse lists and remembers it. */
export const updateBrowseView = (update: (view: BrowseView) => BrowseView): void => {
  view = update(current());
  writeValue(KEY, encodeView(view));

  for (const listener of listeners) listener();
};
