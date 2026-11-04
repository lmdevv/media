import { LibraryId, TitleId } from "@media/contracts/ids";
import { Schema } from "effect";

/** Parses a `$libraryId` route parameter; an empty one fails the route. */
export const parseLibraryId = Schema.decodeUnknownSync(LibraryId);

/** Parses a `$titleId` route parameter; an empty one fails the route. */
export const parseTitleId = Schema.decodeUnknownSync(TitleId);
