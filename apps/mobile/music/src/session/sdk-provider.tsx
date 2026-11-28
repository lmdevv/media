import { sessionKeyFor } from "@media/mobile-core/records";
import { savedAnswers } from "@media/mobile-core/saved-answers";
import { readHealth } from "@media/mobile-core/server";
import type { Health, ServerConnection } from "@media/mobile-core/server";
import { followServer } from "@media/mobile-core/server-release";
import type { ServerFollow, ThisApp } from "@media/mobile-core/server-release";
import { signInUrlFor } from "@media/sdk/promise";
import { PlatformProvider } from "@media/sdk/react";
import { Option } from "effect";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { appKeychains } from "@/lib/keychains";
import { SAVED_QUERIES } from "@/lib/saved-queries";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { launchDoubt, releaseReread } from "@/session/media-requests";
import type { LaunchDoubt } from "@/session/media-requests";

const THIS_APP: ThisApp = {
  version: Constants.expoConfig?.version,
  device: DEVICE_FAMILY,
};

interface ServerHealth {
  readonly read: () => Promise<Option.Option<Health>>;
  readonly launch: LaunchDoubt;
}

const ServerHealthContext = createContext<ServerHealth | null>(null);

/**
 * Follows the server's release while the connection lasts, reading it once now; when that read
 * goes unanswered while the follow lasts, `launch` keeps the doubt for the connection's first
 * watch. A read made again after an answer the app couldn't read tells the listening watch. Returns the read of its health check, which `ServerReachProvider` sends whenever it checks
 * the server, as on coming back on screen, so the release is read again with it.
 */
const useServerRelease = (mediaUrl: string, launch: LaunchDoubt): ServerFollow["refresh"] => {
  const current = useRef<ServerFollow | null>(null);

  useEffect(() => {
    const followed = followServer(mediaUrl, THIS_APP, releaseReread);

    current.current = followed;

    const readNow = async (): Promise<void> => {
      const health = await followed.refresh();

      if (Option.isNone(health) && current.current === followed) launch.failed();
    };

    void readNow();

    return () => {
      followed.stop();

      if (current.current === followed) current.current = null;
    };
  }, [mediaUrl, launch]);

  return useCallback(() => current.current?.refresh() ?? readHealth(mediaUrl), [mediaUrl]);
};

/**
 * Reads the server's health check, and its release with it for the update line: the one request
 * the app sends to learn both. `launch` holds the connection's doubt from its read at launch.
 *
 * @throws When used outside `SdkProvider`, a programming error.
 */
export const useServerHealth = (): ServerHealth => {
  const health = use(ServerHealthContext);

  if (health === null) throw new Error("useServerHealth needs SdkProvider above it");

  return health;
};

/**
 * The platform client for `connection`, provided to everything below. Its session lives in this
 * app's own keychain group (D48), and every sign-in goes through the media server's sign-in boundary.
 * It saves Home's answers for the next launch to show at once. It also follows the server's
 * release, so an answer this app can't read asks to update it.
 */
export function SdkProvider({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
  const [launch] = useState(launchDoubt);
  const read = useServerRelease(connection.mediaUrl, launch);
  const health = useMemo(() => ({ read, launch }), [read, launch]);

  // Held for the provider's life, which its `key` ties to the server and attempt: a new object
  // opens a new client. None when another person took the phone in the movies app since this app
  // last signed in (`savedAnswers`).
  const [saved] = useState(() =>
    savedAnswers({
      cacheFile: (name) => new File(Paths.cache, name),
      convexUrl: connection.convexUrl,
      release: THIS_APP.version ?? "unknown",
      queries: SAVED_QUERIES,
      here: { ...appKeychains(), server: connection.mediaUrl },
    }),
  );

  return (
    <PlatformProvider
      url={connection.convexUrl}
      signInUrl={signInUrlFor(connection.mediaUrl)}
      storage={appKeychains().sessions}
      storageKey={sessionKeyFor(connection.mediaUrl)}
      saved={saved}
    >
      <ServerHealthContext value={health}>{children}</ServerHealthContext>
    </PlatformProvider>
  );
}
