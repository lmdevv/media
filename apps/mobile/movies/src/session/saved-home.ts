import { savedAnswers } from "@media/mobile-core/saved-answers";
import type { SaveAnswers } from "@media/sdk/react";
import { File, Paths } from "expo-file-system";

import { SAVED_QUERIES } from "@/components/browse/held-home";

/** This release's saved answers for the server whose core is at `convexUrl`. */
export const savedHome = (convexUrl: string, release: string): SaveAnswers =>
  savedAnswers({
    cacheFile: (name) => new File(Paths.cache, name),
    convexUrl,
    release,
    queries: SAVED_QUERIES,
  });
