import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Movies = PlatformSdk["movies"];

/** A movie or a show in a row, a grid, or a search result. */
export type TitleCard = RowOf<Movies["titles"]["list"]>;

/** A movie or show with its seasons, versions, credits, and your progress and list. */
export type TitleDetail = Result<Movies["titles"]["get"]>;

export type Home = Result<Movies["titles"]["home"]>;

export type TitleKind = TitleCard["kind"];

export type TitleSort = NonNullable<Parameters<Movies["titles"]["list"]>[0]["sort"]>;

/** An episode with your progress. */
export type Episode = NonNullable<TitleDetail["nextEpisode"]>;

/** An episode as a season's list shows it, with its credits. */
export type SeasonEpisode = RowOf<Movies["titles"]["episodes"]>;

export type Credit = TitleDetail["cast"][number];

export type CreditKind = Credit["kind"];

export type ShowStatus = NonNullable<TitleDetail["status"]>;

/** A movie's file on disk with its probe. */
type MediaFile = TitleDetail["files"][number];

export type AudioStream = MediaFile["probe"]["audio"][number];

/** A version on disk of a movie or an episode. */
export type MediaVersion = Result<Movies["titles"]["versions"]>[number];

export type Progress = NonNullable<TitleDetail["progress"]>;

export type ContinueWatchingItem = Result<Movies["history"]["continueWatching"]>[number];

export type PersonCard = Result<Movies["people"]["search"]>[number];

type PersonDetail = Result<Movies["people"]["get"]>;

export type Collection = Result<Movies["collections"]["get"]>;

export type TitleId = TitleCard["id"];

export type EpisodeId = Episode["id"];

export type MediaFileId = MediaFile["id"];

export type PersonId = PersonDetail["id"];

export type CollectionId = Collection["id"];

/**
 * IDs read from a route's path. They are not checked here: the core checks every ID it is sent, so
 * a mistyped one fails the page's query.
 */
export const asTitleId = Brand.nominal<TitleId>();

export const asPersonId = Brand.nominal<PersonId>();

export const asCollectionId = Brand.nominal<CollectionId>();

export const asEpisodeId = Brand.nominal<EpisodeId>();

export const asMediaFileId = Brand.nominal<MediaFileId>();

/** A season of a show, as its title lists it. */
export type Season = TitleDetail["seasons"][number];

/** A movie or episode someone played, with where they stand on it. */
export type HistoryEntry = RowOf<Movies["history"]["list"]>;
