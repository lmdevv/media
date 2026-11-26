import { sessionKeyFor } from "@media/mobile-core/records";
import { readHealth } from "@media/mobile-core/server";
import type { Health, ServerConnection } from "@media/mobile-core/server";
import { followServer } from "@media/mobile-core/server-release";
import type { ServerFollow, ThisApp } from "@media/mobile-core/server-release";
import { signInUrlFor } from "@media/sdk/promise";
import { PlatformProvider } from "@media/sdk/react";
import { Option } from "effect";
import Constants from "expo-constants";
import { createContext, use, useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { appKeychains } from "@/lib/keychains";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { mediaFailed } from "@/session/media-failures";

const THIS_APP: ThisApp = {
  version: Constants.expoConfig?.version,
  device: DEVICE_FAMILY,
};

const ServerHealthContext = createContext<(() => Promise<Option.Option<Health>>) | null>(null);

/**
 * Follows the server's release while the connection lasts, reading it once now; a read that goes
 * unanswered doubts the media service (`mediaFailed`). Returns the read
 * of its health check, which `ServerReachProvider` sends whenever it checks the server, as on
 * coming back on screen, so the release is read again with it.
 */
const useServerRelease = (mediaUrl: string): ServerFollow["refresh"] => {
  const current = useRef<ServerFollow | null>(null);

  useEffect(() => {
    const followed = followServer(mediaUrl, THIS_APP);

    current.current = followed;

    const readNow = async (): Promise<void> => {
      if (Option.isNone(await followed.refresh())) mediaFailed(null);
    };

    void readNow();

    return () => {
      followed.stop();

      if (current.current === followed) current.current = null;
    };
  }, [mediaUrl]);

  return useCallback(() => current.current?.refresh() ?? readHealth(mediaUrl), [mediaUrl]);
};

/**
 * Reads the server's health check, and its release with it for the update line: the one request
 * the app sends to learn both.
 *
 * @throws When used outside `SdkProvider`, a programming error.
 */
export const useServerHealth = (): (() => Promise<Option.Option<Health>>) => {
  const read = use(ServerHealthContext);

  if (read === null) throw new Error("useServerHealth needs SdkProvider above it");

  return read;
};

/**
 * The platform client for `connection`, provided to everything below. Its session lives in this
 * app's own keychain group (D48), and every sign-in goes through the media server's sign-in boundary.
 * It also follows the server's release, so an answer this app can't read asks to update it.
 */
export function SdkProvider({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
  const health = useServerRelease(connection.mediaUrl);

  return (
    <PlatformProvider
      url={connection.convexUrl}
      signInUrl={signInUrlFor(connection.mediaUrl)}
      storage={appKeychains().sessions}
      storageKey={sessionKeyFor(connection.mediaUrl)}
    >
      <ServerHealthContext value={health}>{children}</ServerHealthContext>
    </PlatformProvider>
  );
}
