import { asEpisodeId, asMediaFileId, asTitleId } from "@/lib/catalog";

type RawParam = string | ReadonlyArray<string> | undefined;

const single = (raw: RawParam): string | undefined => [raw].flat()[0];

/**
 * Reads an ID from a route. Only an empty one is refused here: the core checks every ID it is
 * sent, so a mistyped one fails the screen's query.
 */
const idParam =
  <Id>(as: (raw: string) => Id) =>
  (raw: RawParam): Id | null => {
    const value = single(raw);

    return value === undefined || value === "" ? null : as(value);
  };

/** The title in a `/title/<titleId>` route, or null when the link names none. */
export const titleIdParam = idParam(asTitleId);

/** The `episodeId` parameter, or null. */
export const episodeIdParam = idParam(asEpisodeId);

/** The `fileId` parameter, a version from `movies.titles.versions`, or null. */
export const fileIdParam = idParam(asMediaFileId);

const SEASON = /^\d{1,4}$/u;

/** The `season` parameter, a season number such as `2` (0 for specials), or null. */
export const seasonParam = (raw: RawParam): number | null => {
  const value = single(raw);

  return value !== undefined && SEASON.test(value) ? Number(value) : null;
};
