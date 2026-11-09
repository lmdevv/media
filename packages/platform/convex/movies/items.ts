import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { LibraryReader, SourceLoader } from "../core/downloadSources";
import { ratingOf } from "../core/permissions/policy";
import type { ContentFacts } from "../core/permissions/policy";

/**
 * The facts a kid's restrictions read about a title, its episodes, and its files: the minimum
 * viewer age an admin set, else the scanned one, and unrated when neither exists, which
 * `hideUnrated` hides. `can()` makes the decision from these (ADR 0005).
 */
export const titleFacts = (title: Doc<"titles">): ContentFacts => ({
  domain: "movies",
  rating: ratingOf(title.overrides?.ageRating ?? title.ageRating),
});

/** An item's library and the facts restrictions read about it. */
export interface PlacedItem {
  readonly library: Doc<"libraries">;
  readonly facts: ContentFacts;
}

const placedTitle = async (
  db: DatabaseReader,
  titleId: Id<"titles">,
  libraryOf: LibraryReader,
): Promise<{ readonly title: Doc<"titles">; readonly placed: PlacedItem } | null> => {
  const title = await db.get(titleId);
  const library = title === null ? null : await libraryOf(title.libraryId);

  return title === null || library?.kind !== "movies"
    ? null
    : { title, placed: { library, facts: titleFacts(title) } };
};

/** A title placed in its movies library, or null when it or its library is gone. Reads 2. */
export const placeTitle = async (
  db: DatabaseReader,
  titleId: Id<"titles">,
  libraryOf: LibraryReader,
): Promise<PlacedItem | null> => (await placedTitle(db, titleId, libraryOf))?.placed ?? null;

/** An episode, placed and rated as its show. Reads 3. */
export const placeEpisode = async (
  db: DatabaseReader,
  episodeId: Id<"episodes">,
  libraryOf: LibraryReader,
): Promise<PlacedItem | null> => {
  const episode = await db.get(episodeId);

  return episode === null ? null : placeTitle(db, episode.titleId, libraryOf);
};

/** A file, placed and rated as the title it plays. Reads 3. */
export const placeFile = async (
  db: DatabaseReader,
  fileId: Id<"mediaFiles">,
  libraryOf: LibraryReader,
): Promise<PlacedItem | null> => {
  const file = await db.get(fileId);

  return file === null ? null : placeTitle(db, file.titleId, libraryOf);
};

/**
 * A movies file as a download describes it: the file the server serves as it is on disk, at every
 * quality, as old movies kept downloads. Its revision changes with the file's size or change time.
 * Reads 3.
 */
export const fileSource: SourceLoader<"file"> = async (db, fileId, libraryOf) => {
  const file = await db.get(fileId);
  const found = file === null ? null : await placedTitle(db, file.titleId, libraryOf);

  if (file === null || found === null) return null;

  return {
    library: found.placed.library._id,
    facts: found.placed.facts,
    resource: { kind: "file", id: file._id },
    revision: `${file.sizeBytes}:${file.mtimeMs}`,
    bytes: () => file.sizeBytes,
    label: found.title.overrides?.name ?? found.title.name,
  };
};
