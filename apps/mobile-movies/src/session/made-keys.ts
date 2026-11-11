import { useSyncExternalStore } from "react";

import { madeKeys } from "@/lib/api-keys";
import type { MadeKey } from "@/lib/api-keys";

/** The API keys made on this phone since the app opened; see `madeKeys`. */
export const MADE_KEYS = madeKeys();

/** The API keys made on this phone since the app opened, newest first, re-rendering on a change. */
export const useMadeKeys = (): ReadonlyArray<MadeKey> =>
  useSyncExternalStore(MADE_KEYS.subscribe, MADE_KEYS.list, MADE_KEYS.list);
