/** Opening a place from the iPad's frame, which sits outside the stacks it drives. */
import { router, useNavigationContainerRef } from "expo-router";
import { StackActions } from "expo-router/react-navigation";
import { useCallback } from "react";

import { popsToOpen } from "@/lib/shell-layout";
import type { Place } from "@/lib/shell-layout";

/**
 * Resets `place`'s tab to it: its root, or one page over its root, and on the tab's first visit
 * too. A plain `navigate` only reuses the page on top of a stack, so it would stack duplicates.
 */
export const useOpenPlace = (): ((place: Place) => void) => {
  const container = useNavigationContainerRef();

  return useCallback(
    (place) => {
      const pops = popsToOpen(container.getRootState(), place);

      if (pops !== null) {
        container.dispatch({ ...StackActions.pop(pops.count), target: pops.stack });
      }

      router.navigate(place.href, { withAnchor: true });
    },
    [container],
  );
};
