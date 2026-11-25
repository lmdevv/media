import { sessionKeyFor } from "@media/mobile-core/records";
import type { ServerConnection } from "@media/mobile-core/server";
import { followServer } from "@media/mobile-core/server-release";
import type { ThisApp } from "@media/mobile-core/server-release";
import { signInUrlFor } from "@media/sdk/promise";
import { PlatformProvider } from "@media/sdk/react";
import Constants from "expo-constants";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AppState, Platform } from "react-native";

import { appKeychains } from "@/lib/keychains";

const THIS_APP: ThisApp = {
  version: Constants.expoConfig?.version,
  device: Platform.OS === "ios" && Platform.isPad ? "iPad" : "iPhone",
};

const useServerRelease = (mediaUrl: string): void => {
  useEffect(() => {
    const followed = followServer(mediaUrl, THIS_APP);

    void followed.refresh();

    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void followed.refresh();
    });

    return () => {
      foreground.remove();
      followed.stop();
    };
  }, [mediaUrl]);
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
  useServerRelease(connection.mediaUrl);

  return (
    <PlatformProvider
      url={connection.convexUrl}
      signInUrl={signInUrlFor(connection.mediaUrl)}
      storage={appKeychains().sessions}
      storageKey={sessionKeyFor(connection.mediaUrl)}
    >
      {children}
    </PlatformProvider>
  );
}
