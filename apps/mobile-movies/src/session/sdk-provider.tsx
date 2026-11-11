import { sessionKeyFor } from "@media/mobile-core/records";
import type { ServerConnection } from "@media/mobile-core/server";
import { signInUrlFor } from "@media/sdk/promise";
import { PlatformProvider } from "@media/sdk/react";
import type { ReactNode } from "react";

import { appKeychains } from "@/lib/keychains";

/**
 * The platform client for `connection`, provided to everything below. Its session lives in this
 * app's own keychain group (D48), and every sign-in goes through the media server's sign-in boundary.
 */
export function SdkProvider({
  connection,
  children,
}: {
  readonly connection: ServerConnection;
  readonly children: ReactNode;
}) {
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
