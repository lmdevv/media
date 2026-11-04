import type { DownloadTarget } from "@music/commands/models";
import { router } from "expo-router";

/** Opens the Remove download sheet for `target`, named `title`. */
export const openRemoveDownload = (target: DownloadTarget, title: string): void => {
  router.push({ pathname: "/download/remove", params: { ...target, title } });
};
