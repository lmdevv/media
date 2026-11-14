import { usePlatform } from "@media/sdk/react";
import { useCallback } from "react";

import { wipeDownloads } from "@/downloads";
import { useServer } from "@/session/connection";

/**
 * Returns the function that signs this app out on the server and here, then deletes this server's
 * downloads on this iPhone. Only this app's session ends: the phone keeps its grant for its other
 * apps, and this app asks for the password next (D59).
 */
export const useSignOut = (): (() => Promise<void>) => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();

  return useCallback(async () => {
    await platform.session.signOut();
    await wipeDownloads(mediaUrl).catch(() => undefined);
  }, [platform, mediaUrl]);
};
