import { router } from "expo-router";

import type { TitleId } from "./catalog";
import { appEvents } from "./app-events";

/** Starts timing the open of title `titleId` from a press that navigates there on its own. */
export const pressTitle = (titleId: TitleId): void => {
  appEvents.pressed("title", titleId);
};

/** Opens the page of title `titleId`, timing the open until its content draws. */
export const openTitle = (titleId: TitleId): void => {
  pressTitle(titleId);
  router.push(`/title/${titleId}`);
};
