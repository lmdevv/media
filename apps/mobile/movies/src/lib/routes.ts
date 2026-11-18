import { Schema } from "effect";
import type { Option } from "effect";

import type { EpisodeId, MediaFileId, TitleId } from "./catalog";

/** What to play: a movie, or a show's episode, in a chosen version, and from where. */
export interface WatchTarget {
  readonly titleId: TitleId;
  /** The episode of a show; omit for a movie, or to let the player choose a show's next one. */
  readonly episodeId?: EpisodeId | undefined;
  /** A version from `titles.versions`; omit to let the server choose. */
  readonly fileId?: MediaFileId | undefined;
  /** `beginning` for Start Over; `resume`, or leaving it out, picks up the saved progress. */
  readonly start?: "beginning" | "resume" | undefined;
  /** Where to start, in milliseconds; omit for the saved progress. */
  readonly at?: number | undefined;
  /** A download kept on this iPhone, played from its file instead of the server. */
  readonly download?: string | undefined;
}

/**
 * The player's href for `target`. Present parameters appear in the order `episodeId`, `fileId`,
 * `start`, `at` (whole milliseconds), `download`, each URI-encoded, so `new URLSearchParams(query)`
 * reads back the same values.
 */
export const watchHref = ({
  titleId,
  episodeId,
  fileId,
  start,
  at,
  download,
}: WatchTarget): string => {
  const query = (
    [
      ["episodeId", episodeId],
      ["fileId", fileId],
      ["start", start],
      ["at", at === undefined ? undefined : String(Math.max(0, Math.round(at)))],
      ["download", download],
    ] as const
  )
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${encodeURIComponent(value)}`]))
    .join("&");

  const path = `/watch/${encodeURIComponent(titleId)}`;

  return query === "" ? path : `${path}?${query}`;
};

// IDs read from a route are not checked here: the core checks every ID it is sent, so a mistyped
// one fails the start.
const RouteId = Schema.String.check(Schema.isNonEmpty());

const WatchParams = Schema.Struct({
  titleId: RouteId.pipe(Schema.brand("Id<titles>")),
  episodeId: Schema.optionalKey(RouteId.pipe(Schema.brand("Id<episodes>"))),
  fileId: Schema.optionalKey(RouteId.pipe(Schema.brand("Id<mediaFiles>"))),
  start: Schema.optionalKey(Schema.Literals(["beginning", "resume"])),
  at: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0))),
  download: Schema.optionalKey(Schema.String),
});

/** What the player plays, read from its route. */
export interface WatchParams extends Schema.Schema.Type<typeof WatchParams> {}

const decodeWatchParams = Schema.decodeUnknownOption(WatchParams);

/** A route's params as Expo Router reads them: a repeated key gives an array. */
type RouteParams = Readonly<Record<string, string | string[] | undefined>>;

const KEYS = ["titleId", "episodeId", "fileId", "start", "at", "download"] as const;

/**
 * The player's params from Expo Router's `useLocalSearchParams()`, or none when the title is
 * missing or a value is malformed. Empty values count as absent; of a repeated key, the first.
 */
export const parseWatchParams = (params: RouteParams): Option.Option<WatchParams> =>
  decodeWatchParams(
    Object.fromEntries(
      KEYS.flatMap((key) => {
        const raw = params[key];
        const value = Array.isArray(raw) ? raw[0] : raw;

        return value === undefined || value === "" ? [] : [[key, value]];
      }),
    ),
  );

/** The Downloads list (C19). */
export const DOWNLOADS_HREF = "/downloads";

/** A download's page (H17, H19), by its ID. */
export const downloadHref = (downloadId: string): string =>
  `/download/${encodeURIComponent(downloadId)}`;

/** The player on a kept download: its title and episode, and the download to play. */
export const playDownloadHref = (download: {
  readonly id: string;
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
}): string =>
  watchHref({
    titleId: download.titleId,
    episodeId: download.episodeId ?? undefined,
    download: download.id,
  });
