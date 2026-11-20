import type { PlatformSdk } from "@media/sdk/promise";
import type { PageOpts } from "@media/ui/lib/pages";
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

/** What Home's billboard shows of its featured title beyond the title's card. */
export type FeaturedDetail = NonNullable<Home["featuredDetail"]>;

/** What Home's billboard shows of a title, from the title's page when Home did not send it. */
export const featuredDetailOf = (detail: TitleDetail): FeaturedDetail => ({
  id: detail.id,
  overview: detail.overview,
  seasonCount: detail.seasons.length,
  version: detail.versions[0] ?? null,
  progress: detail.progress,
  nextEpisode: detail.nextEpisode,
  inMyList: detail.inMyList,
});

export type TitleKind = TitleCard["kind"];

export type TitleSort = NonNullable<Parameters<Movies["titles"]["list"]>[0]["sort"]>;

export type PlaybackDetail = Result<Movies["playback"]["get"]>;

/** An episode with your progress. */
export type Episode = NonNullable<TitleDetail["nextEpisode"]>;

/** An episode as a season's list shows it, with its credits. */
export type SeasonEpisode = RowOf<Movies["titles"]["episodes"]>;

export type Credit = TitleDetail["cast"][number];

export type CreditKind = Credit["kind"];

export type ExternalIds = TitleDetail["externalIds"];

export type Ratings = TitleDetail["ratings"];

export type ShowStatus = NonNullable<TitleDetail["status"]>;

export type Trailer = NonNullable<TitleDetail["trailer"]>;

/** A movie's file on disk with its probe. */
export type MediaFile = TitleDetail["files"][number];

export type AudioStream = MediaFile["probe"]["audio"][number];

/** A version on disk of a movie or an episode. */
export type MediaVersion = Result<Movies["titles"]["versions"]>[number];

export type Progress = NonNullable<TitleDetail["progress"]>;

export type ContinueWatchingItem = Result<Movies["history"]["continueWatching"]>[number];

export type PersonCard = Result<Movies["people"]["search"]>[number];

export type PersonDetail = Result<Movies["people"]["get"]>;

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

/**
 * The arguments of each page of the collections, shared by the Collections page, Home's
 * Collections row, and their routes' loaders, so all of them follow one subscription.
 */
export const collectionsPage = (paginationOpts: PageOpts) => ({ paginationOpts });
