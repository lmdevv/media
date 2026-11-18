import { createMediaServer } from "@media/sdk/promise";
import type { MediaServer, PlatformSdk } from "@media/sdk/promise";

const servers = new WeakMap<PlatformSdk, MediaServer>();

/**
 * The media server at `url`, called as `platform`'s session under the refusal rule every platform
 * call follows (a refusal of the session the call carried refreshes it once), one client per
 * platform client, so every caller shares one repeat window for error reports.
 */
export const mediaServerOf = (platform: PlatformSdk, url: string): MediaServer => {
  const known = servers.get(platform);

  if (known !== undefined) return known;

  const server = createMediaServer({ url, session: platform.session });

  servers.set(platform, server);

  return server;
};
