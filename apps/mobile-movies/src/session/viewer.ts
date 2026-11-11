import { usePlatform } from "@media/sdk/react";
import { useCallback } from "react";

/**
 * Signs this app's person out on the server and here. The phone keeps its grant, so the app's
 * other person signs in with a password next, and that sign-in replaces the grant (D64). This app
 * never exchanges the grant again (D59).
 */
export const useSignOut = (): (() => Promise<void>) => {
  const platform = usePlatform();

  return useCallback(() => platform.session.signOut(), [platform]);
};
