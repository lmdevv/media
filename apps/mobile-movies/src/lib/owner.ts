/**
 * What the owner screens read from the core: libraries with their scans and files, imports, and
 * backups, typed from the platform SDK's commands.
 */
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Core = PlatformSdk["core"];

type Movies = PlatformSdk["movies"];

/** A library shared with this person, with their grant level. */
export type Library = RowOf<Core["libraries"]["list"]>;

/** A library with its item count, folders, and latest scan. */
export type LibraryDetail = Result<Core["libraries"]["get"]>;

/** A library's latest scan. */
export type Scan = NonNullable<LibraryDetail["scan"]>;

/** A library's id on the core. */
export type LibraryId = Library["libraryId"];

/** One file of a library as its managers review it, with its title, episode, and match. */
export type LibraryFile = RowOf<Movies["files"]["list"]>;

/** A library's missing files and its unmatched titles; null counts for a restricted editor. */
export type LibraryFileSummary = Result<Movies["files"]["summary"]>;

/** One run of the Jellyfin or Plex importer. */
export type ImportRun = Result<Movies["imports"]["get"]>;

/** An import's id on the core. */
export type ImportId = ImportRun["importId"];

/** What a cancel answers: finished, canceling, or moved on to a later attempt. */
export type Canceled = Result<Core["libraries"]["cancelScan"]>;

/**
 * IDs read from a route. They are not checked here: the core checks every ID it is sent, so a
 * mistyped one fails the screen's query.
 */
export const asLibraryId = Brand.nominal<LibraryId>();

export const asImportId = Brand.nominal<ImportId>();

/** The movies libraries this person manages, which the owner screens list. */
export const managedMovieLibraries = (libraries: ReadonlyArray<Library>): ReadonlyArray<Library> =>
  libraries.filter((library) => library.kind === "movies" && library.level === "manage");

/**
 * The line to show when a scan's cancel changed nothing because the job was claimed again after the
 * person looked: the screen then shows that later attempt, which they may cancel. Null otherwise.
 */
export const movedOnLine = (answer: Canceled): string | null =>
  answer.outcome === "movedOn" ? "The scan started over before the cancel arrived." : null;
