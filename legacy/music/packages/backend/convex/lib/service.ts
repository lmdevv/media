import { timingSafeEqual } from "@music/commands/signed-url";

import { requireEnv } from "./env";
import { fail } from "./errors";

/** Checks the media service secret with a constant-time compare. */
export const requireService = (secret: string): void => {
  if (!timingSafeEqual(secret, requireEnv("MEDIA_SERVICE_SECRET"))) {
    fail("forbidden", "Invalid media service secret");
  }
};
