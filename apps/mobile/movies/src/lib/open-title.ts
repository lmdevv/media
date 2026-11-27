import { router } from "expo-router";

import type { TitleId } from "./catalog";
import { pressedOpen } from "./app-events";

/** Times the open of title `titleId` from `press`, which navigates there on its own. */
export const pressTitle = (titleId: TitleId, press: { readonly nativeEvent: unknown }): void => {
  pressedOpen("title", titleId, press);
};

/**
 * Opens the page of title `titleId`. With the `press` that asked for it, times the open from its
 * touch until the title's content is in view; a menu action, which has no touch, times nothing.
 */
export const openTitle = (titleId: TitleId, press?: { readonly nativeEvent: unknown }): void => {
  if (press !== undefined) pressTitle(titleId, press);
  router.push(`/title/${titleId}`);
};
