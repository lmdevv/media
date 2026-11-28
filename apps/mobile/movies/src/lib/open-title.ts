import { router } from "expo-router";

import type { TitleId } from "./catalog";
import { pressedOpen } from "./app-events";

/**
 * Opens the page of title `titleId`. With the `press` that asked for it, times the open from its
 * touch until the title's content is in view; a menu action, which has no touch, times nothing.
 * It navigates as a `Link` to the page does, so a second press while that page is already on top
 * opens no second copy of it.
 */
export const openTitle = (titleId: TitleId, press?: { readonly nativeEvent: unknown }): void => {
  if (press !== undefined) pressedOpen("title", titleId, press);
  router.navigate(`/title/${titleId}`);
};
