import { openingPageArgs } from "@media/contracts/opening-season";
import { usePages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";

import type { TitleId } from "@/lib/catalog";

/**
 * Holds the first page of the season a title's screen opens on, with the season left for the
 * server to pick, so the episode list has its answer when it mounts after the title answers. The
 * list asks for the same page through `seasonPageArgs`. A movie holds an empty page, and a server
 * that predates the optional season refuses it, which shows nowhere.
 */
export const useOpeningEpisodes = (titleId: TitleId): void => {
  const platform = usePlatform();

  usePages(platform.movies.titles.episodes, (paginationOpts) =>
    openingPageArgs(titleId, paginationOpts),
  );
};
