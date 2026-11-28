import { usePlatform } from "@media/sdk/react";
import { useCallback } from "react";

import { releaseDownloads, wipeDownloads } from "@/downloads";
import { useServer } from "@/session/connection";

import { signOutInOrder } from "./sign-out-steps";

/**
 * Returns the function that signs this app out on the server and here, then deletes this server's
 * downloads on this iPhone. First it tells the core the person keeps none here any more, waiting
 * up to 5 s while the server answers, since only their session can, and it deletes the downloads
 * even when signing out rejects (`signOutInOrder`). Only this app's session ends: the phone keeps its grant for its other apps, and this app asks for the password next
 * (D59).
 */
export const useSignOut = (): (() => Promise<void>) => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();

  return useCallback(
    () =>
      signOutInOrder({
        release: () => releaseDownloads(mediaUrl),
        signOut: () => platform.session.signOut(),
        wipe: () => wipeDownloads(mediaUrl),
      }),
    [platform, mediaUrl],
  );
};
