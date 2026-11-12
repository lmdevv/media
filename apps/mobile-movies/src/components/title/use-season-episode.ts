import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";

import type { EpisodeId, SeasonEpisode, TitleId } from "@/lib/catalog";

/** An episode of a season as `movies.titles.episodes` lists it, while it loads or once it has. */
type SeasonEpisodeState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly episode: SeasonEpisode | null };

/**
 * The season's episodes as `movies.titles.episodes` lists them, narrowed to `episodeId`: null when
 * the season, read to its end, does not hold it.
 */
export const useSeasonEpisode = (
  titleId: TitleId | null,
  episodeId: EpisodeId | null,
  seasonNumber: number | null,
): SeasonEpisodeState => {
  const platform = usePlatform();

  const episodes = useAllPages(
    platform.movies.titles.episodes,
    titleId === null || episodeId === null || seasonNumber === null
      ? "skip"
      : (paginationOpts) => ({ titleId, seasonNumber, paginationOpts }),
  );

  if (episodes.status === "loading") return episodes;

  if (episodes.status === "failed") return { status: "failed", message: episodes.message };

  const episode = episodes.rows.find((candidate) => candidate.id === episodeId);

  if (episode !== undefined) return { status: "ready", episode };

  const { next } = episodes;

  if (next.kind === "failed") return { status: "failed", message: next.message };

  return next.kind === "done" ? { status: "ready", episode: null } : { status: "loading" };
};
