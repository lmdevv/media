import { usePlatform } from "@media/sdk/react";
import { useCallback } from "react";

import { useDownloads } from "./downloads";

/**
 * Signs this app's person out on the server and here, removing their downloads from this iPhone
 * first, and from the server's count for it while the server answers. The phone keeps its grant,
 * so the app's other person signs in with a password next, and that sign-in replaces the grant
 * (D64). This app never exchanges the grant again (D59).
 */
export const useSignOut = (): (() => Promise<void>) => {
  const platform = usePlatform();
  const { engine } = useDownloads();

  return useCallback(async () => {
    await engine?.signOut();
    await platform.session.signOut();
  }, [platform, engine]);
};
