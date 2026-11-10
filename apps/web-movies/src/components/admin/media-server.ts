import { createMediaServer } from "@media/sdk/promise";
import type { MediaServer } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

import { MEDIA_BASE_URL } from "@/env";

/** The media server's own routes, called as the signed-in person with the session's token. */
export const useMediaServer = (): MediaServer => {
  const platform = usePlatform();

  return useMemo(
    () => createMediaServer({ url: MEDIA_BASE_URL, accessToken: platform.session.accessToken }),
    [platform],
  );
};
