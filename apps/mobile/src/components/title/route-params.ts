import { EpisodeId, MediaFileId, RoomId, TitleId } from "@media/contracts/ids";
import { Option, Schema } from "effect";

type RawParam = string | ReadonlyArray<string> | undefined;

const single = (raw: RawParam): string | undefined => [raw].flat()[0];

const decoder =
  <A>(schema: Schema.Codec<A, string>) =>
  (raw: RawParam): A | null =>
    Option.getOrNull(Schema.decodeUnknownOption(schema)(single(raw)));

/** The title in a `/title/<titleId>` route, or null when the link names none. */
export const titleIdParam = decoder(TitleId);

/** The `episodeId` parameter, or null. */
export const episodeIdParam = decoder(EpisodeId);

/** The `fileId` parameter, a version from `titles.versions`, or null. */
export const fileIdParam = decoder(MediaFileId);

/** The room in a `/room/<roomId>` route, or null when the link names none. */
export const roomIdParam = decoder(RoomId);

const SEASON = /^\d{1,4}$/u;

/** The `season` parameter, a season number such as `2` (0 for specials), or null. */
export const seasonParam = (raw: RawParam): number | null => {
  const value = single(raw);

  return value !== undefined && SEASON.test(value) ? Number(value) : null;
};
