import { usePlatform } from "@media/sdk/react";
import { toastFailure } from "@media/ui/lib/failure";
import { useCallback } from "react";
import { toast } from "sonner";

import { useCurrentSession } from "./current-session";
import { itemOf } from "./session";
import type { WatchTarget } from "./session";

/**
 * Queues `target` last in the person's movies session, or null when they are in none or the host
 * has not let guests add. The core checks again that they may play it.
 */
export const useAddToSession = (target: WatchTarget, name: string): (() => void) | null => {
  const platform = usePlatform();
  const view = useCurrentSession();
  const may = view?.state === "joined" && view.may.add;
  const { titleId, episodeId } = target;

  const add = useCallback((): void => {
    void platform.core.together
      .add({ item: itemOf({ titleId, episodeId }), at: "end" })
      .then(() => toast.success(`${name} is in Up next`), toastFailure);
  }, [platform, titleId, episodeId, name]);

  return may ? add : null;
};
