import type { MediaServer } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";

import { mediaServerOf } from "@/lib/media-server";

import { useServer } from "./connection";

/** The media server's own routes as the signed-in person, under the platform's refusal rule. */
export const useMediaServer = (): MediaServer => mediaServerOf(usePlatform(), useServer().mediaUrl);
