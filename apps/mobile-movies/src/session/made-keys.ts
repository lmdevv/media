import { useCallback, useMemo, useSyncExternalStore } from "react";

import { madeKeys } from "@/lib/api-keys";
import type { ApiKeyId, MadeKey } from "@/lib/api-keys";

import { useServer } from "./connection";
import { useMe } from "./me";

/** The API keys made on this phone since the app opened, per person and server; see `madeKeys`. */
const MADE_KEYS = madeKeys();

/** The signed-in person's keys made here, and the ways to change that list. */
export interface MadeKeysHere {
  /** Newest first. */
  readonly keys: ReadonlyArray<MadeKey>;
  readonly add: (key: MadeKey) => void;
  readonly revoked: (keyId: ApiKeyId) => void;
  readonly endedAll: () => void;
}

/**
 * The API keys the signed-in person made on this phone, on this server, since the app opened,
 * re-rendering on a change. Another person or server sees only their own.
 */
export const useMadeKeys = (): MadeKeysHere => {
  const { mediaUrl } = useServer();
  const { userId } = useMe();
  const owner = useMemo(() => ({ server: mediaUrl, userId }), [mediaUrl, userId]);
  const read = useCallback(() => MADE_KEYS.list(owner), [owner]);
  const keys = useSyncExternalStore(MADE_KEYS.subscribe, read, read);

  return useMemo(
    () => ({
      keys,
      add: (key) => MADE_KEYS.add(owner, key),
      revoked: (keyId) => MADE_KEYS.revoked(owner, keyId),
      endedAll: () => MADE_KEYS.endedAll(owner),
    }),
    [keys, owner],
  );
};
