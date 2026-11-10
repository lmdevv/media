import { Schema } from "effect";

const LibraryId = Schema.NonEmptyString.pipe(Schema.brand("Id<libraries>"));

const TitleId = Schema.NonEmptyString.pipe(Schema.brand("Id<titles>"));

/** A library's ID on the core, as its commands take it. */
export type LibraryId = typeof LibraryId.Type;

/** A title's ID on the core, as its commands take it. */
export type TitleId = typeof TitleId.Type;

/** Parses a `$libraryId` route parameter; an empty one fails the route. */
export const parseLibraryId = Schema.decodeUnknownSync(LibraryId);

/** Parses a `$titleId` route parameter; an empty one fails the route. */
export const parseTitleId = Schema.decodeUnknownSync(TitleId);

/** An import's ID on the core, as `movies.imports.get` takes it. */
export const ImportRunId = Schema.NonEmptyString.pipe(Schema.brand("Id<imports>"));

/** An import's ID on the core. */
export type ImportRunId = typeof ImportRunId.Type;

/** Parses an import's ID, such as the one `imports.start` answers with. */
export const parseImportRunId = Schema.decodeUnknownSync(ImportRunId);
