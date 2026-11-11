import { usePlatform } from "@media/sdk/react";

import type { SeasonEpisode, TitleId } from "@/lib/catalog";
import { useAllPages } from "@/lib/pages";

const NO_EPISODES: ReadonlyArray<SeasonEpisode> = [];

/**
 * Every episode of `titleId`'s season `seasonNumber` in order, with the person's progress, kept
 * current; empty with no season, while they load, or when they could not load.
 */
export const useSeasonEpisodes = (
  titleId: TitleId,
  seasonNumber: number | null,
): ReadonlyArray<SeasonEpisode> => {
  const platform = usePlatform();

  const episodes = useAllPages(
    platform.movies.titles.episodes,
    seasonNumber === null
      ? "skip"
      : (paginationOpts) => ({ titleId, seasonNumber, paginationOpts }),
  );

  return episodes.status === "ready" ? episodes.rows : NO_EPISODES;
};
