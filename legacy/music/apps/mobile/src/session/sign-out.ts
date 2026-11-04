import { useAuthActions } from "@convex-dev/auth/react";
import { useCallback } from "react";

import { wipeDownloads } from "@/downloads";
import { saveAccount } from "@/lib/account-memory";
import { useConnection } from "@/session/connection";

/** Returns the function that signs out and deletes this server's downloads on this iPhone. */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuthActions();
  const { origin } = useConnection();

  return useCallback(async () => {
    await signOut();
    saveAccount(origin, null);

    await wipeDownloads(origin).catch(() => undefined);
  }, [signOut, origin]);
};
