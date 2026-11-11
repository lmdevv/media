import { createMediaServer } from "@media/sdk/promise";
import type { MediaServer, PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";

import { useServer } from "./connection";

const servers = new WeakMap<PlatformSdk, MediaServer>();

/**
 * The media server's own routes as the signed-in person, one client per platform client, so every
 * caller shares one repeat window for error reports.
 */
export const useMediaServer = (): MediaServer => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const known = servers.get(platform);

  if (known !== undefined) return known;

  const server = createMediaServer({ url: mediaUrl, accessToken: platform.session.accessToken });

  servers.set(platform, server);

  return server;
};
