import { savedAnswers } from "@media/mobile-core/saved-answers";
import type { ServerConnection } from "@media/mobile-core/server";
import type { SaveAnswers } from "@media/sdk/react";
import { File, Paths } from "expo-file-system";

import { SAVED_QUERIES } from "@/components/browse/held-home";
import { appKeychains } from "@/lib/keychains";

/**
 * This release's saved answers for `connection`'s server, or none when another person has taken
 * the phone in a sibling app since this app last signed in (`savedAnswers`).
 */
export const savedHome = (connection: ServerConnection, release: string): SaveAnswers | undefined =>
  savedAnswers({
    cacheFile: (name) => new File(Paths.cache, name),
    convexUrl: connection.convexUrl,
    release,
    queries: SAVED_QUERIES,
    here: { ...appKeychains(), server: connection.mediaUrl },
  });
