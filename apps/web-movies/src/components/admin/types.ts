import type { PlatformSdk } from "@media/sdk/promise";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Core = PlatformSdk["core"];

type Movies = PlatformSdk["movies"];

/** A library as the core lists it, with the caller's grant level. */
export type Library = RowOf<Core["libraries"]["list"]>;

/** A library with its items, folders, and latest scan. */
export type LibraryDetail = Result<Core["libraries"]["get"]>;

/** A library's latest scan. */
export type Scan = NonNullable<LibraryDetail["scan"]>;

/** A movie or show in a library's title list. */
export type TitleCard = RowOf<Movies["titles"]["list"]>;

/** A movie or show with its match, files, and versions. */
export type TitleDetail = Result<Movies["titles"]["get"]>;

/** One version on disk of a movie or an episode. */
export type MediaVersion = TitleDetail["versions"][number];

/** One run of the Jellyfin or Plex importer. */
export type ImportRun = Result<Movies["imports"]["get"]>;

/** The edits `movies.metadata.edit` sets on a title. */
export type MetadataOverrides = Parameters<Movies["metadata"]["edit"]>[0]["set"];

/** A user here, as the importer maps source users onto them. */
export type Person = RowOf<Core["accounts"]["users"]["list"]>;
