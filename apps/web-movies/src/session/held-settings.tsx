import { usePlatform, usePlatformQuery } from "@media/sdk/react";

/**
 * Holds the person's settings for as long as they are signed in. The player's first request takes
 * their saved quality and waits for these settings; held here, they have answered before the
 * player opens.
 */
export function HeldSettings() {
  const platform = usePlatform();

  usePlatformQuery(platform.core.settings.get);

  return null;
}
