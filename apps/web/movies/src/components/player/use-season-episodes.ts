import type { QueryState } from "@media/sdk/react";
import { usePlatform } from "@media/sdk/react";
import { useAllPages } from "@media/ui/lib/pages";
import type { PagedQuery, Watch } from "@media/ui/lib/pages";

import type { SeasonEpisode, TitleId } from "@/lib/catalog";

type SeasonArgs = Parameters<ReturnType<typeof usePlatform>["movies"]["titles"]["episodes"]>[0];

const LOADING: QueryState<never> = { status: "loading" };

const WAITING: Watch<never> = { subscribe: () => () => undefined, getSnapshot: () => LOADING };

/** A season query that waits, for a player with no season to list. */
const NO_SEASON: PagedQuery<SeasonArgs, never> = { watch: () => WAITING };

const NO_EPISODES: ReadonlyArray<SeasonEpisode> = [];

/**
 * Every episode of `titleId`'s season `seasonNumber` in order, with the person's progress, followed
 * live page by page; null while the first page loads or with no season, and empty when they could
 * not load.
 */
export const useSeasonEpisodes = (
  titleId: TitleId,
  seasonNumber: number | null,
): ReadonlyArray<SeasonEpisode> | null => {
  const platform = usePlatform();

  const query: PagedQuery<SeasonArgs, SeasonEpisode> =
    seasonNumber === null ? NO_SEASON : platform.movies.titles.episodes;

  const pages = useAllPages(query, (paginationOpts) => ({
    titleId,
    seasonNumber: seasonNumber ?? 0,
    paginationOpts,
  }));

  if (pages.status === "loading") return null;

  return pages.status === "ready" ? pages.rows : NO_EPISODES;
};
