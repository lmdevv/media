/**
 * Signing out of the connected server, the one way the app does it: from Settings, after a
 * screen found the session gone, and when the server ends the session (signed out elsewhere,
 * suspended, removed). Each also deletes the downloads kept for that server on this iPhone.
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { useCallback } from "react";

import { wipeDownloads } from "@/downloads";
import { useConnection } from "@/session/connection";

/** Returns the function that signs out and deletes this server's downloads on this iPhone. */
export const useSignOut = (): (() => Promise<void>) => {
  const { signOut } = useAuthActions();
  const { origin } = useConnection();

  return useCallback(async () => {
    await signOut();

    // Files a failed wipe leaves go with the next one, which takes the server's whole directory.
    await wipeDownloads(origin).catch(() => undefined);
  }, [signOut, origin]);
};
