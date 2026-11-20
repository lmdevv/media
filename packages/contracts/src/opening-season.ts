/**
 * The season a show's page opens on. `movies.titles.episodes` answers it when the season is left
 * out, and the web and iOS clients head the list with it, so the rows and their heading agree.
 */

/** What the opening season is decided from. */
export interface OpeningSeasonInput {
  /** The season of the episode the show's Play button starts, or null when there is none. */
  readonly nextSeason: number | null;
  /**
   * Season numbers in ascending order: the show's seasons, or at least its lowest season and its
   * lowest regular one (above 0).
   */
  readonly seasons: ReadonlyArray<number>;
}

/**
 * The next episode's season, else the first regular season, so a show with no next episode opens
 * on Season 1 rather than its Specials (season 0), else its first season. Null for a show with no
 * seasons.
 */
export const openingSeason = ({ nextSeason, seasons }: OpeningSeasonInput): number | null =>
  nextSeason ?? seasons.find((season) => season > 0) ?? seasons[0] ?? null;

/**
 * Whether every one of `episodes` is of `seasonNumber`. The page that leaves the season out
 * follows the opening season as it moves, on its own schedule, so a list that heads its rows with
 * a season shows them only while this holds, and names its season from then on.
 */
export const allOfSeason = (
  episodes: ReadonlyArray<{ readonly seasonNumber: number }>,
  seasonNumber: number,
): boolean => episodes.every((episode) => episode.seasonNumber === seasonNumber);

/** Where a page of episodes starts and, once pinned, ends. */
interface EpisodePageSpan {
  readonly cursor: string | null;
  readonly endCursor?: string | null;
}

/**
 * The arguments of the first page of the season a show's page opens on, with the season left for
 * the server to pick. A page holds this from the moment it opens, before it knows the season.
 */
export const openingPageArgs = <TitleId, Opts extends EpisodePageSpan>(
  titleId: TitleId,
  paginationOpts: Opts,
) => ({ titleId, paginationOpts });

/**
 * The arguments of a page of `seasonNumber`'s episodes. The open-ended first page of the opening
 * season is {@link openingPageArgs}, so it answers from the subscription the page already holds.
 * Every other page names the season: a cursor holds only within one season, and a list pinned to
 * a season must stay on it when the opening season moves.
 *
 * @param opening - Whether `seasonNumber` is the season the server opens on, by the same answers.
 */
export const seasonPageArgs = <TitleId, Opts extends EpisodePageSpan>(
  titleId: TitleId,
  seasonNumber: number,
  opening: boolean,
  paginationOpts: Opts,
) =>
  opening && paginationOpts.cursor === null && (paginationOpts.endCursor ?? null) === null
    ? openingPageArgs(titleId, paginationOpts)
    : { titleId, seasonNumber, paginationOpts };
