import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { LibraryReader, SourceLoader } from "../core/downloadSources";
import type { ContentFacts } from "../core/permissions/policy";

/**
 * The facts a kid's restrictions read about a track: whether its tags mark it explicit, which the
 * explicit filter hides (D17). `can()` makes the decision from these (ADR 0005).
 */
export const trackFacts = (track: Pick<Doc<"tracks">, "explicit">): ContentFacts => ({
  domain: "music",
  explicit: track.explicit,
});

/**
 * An album's own facts. An album is never explicit itself: a kid sees it, and each of its tracks
 * is decided on its own facts when it plays, so the explicit filter hides only the explicit ones.
 */
const ALBUM_FACTS: ContentFacts = { domain: "music", explicit: false };

/** An item's library and the facts restrictions read about it. */
export interface PlacedItem {
  readonly library: Doc<"libraries">;
  readonly facts: ContentFacts;
}

const inMusic = async (
  libraryOf: LibraryReader,
  libraryId: Id<"libraries">,
  facts: ContentFacts,
): Promise<PlacedItem | null> => {
  const library = await libraryOf(libraryId);

  return library?.kind === "music" ? { library, facts } : null;
};

/**
 * A track placed in its music library, or null when it or its library is gone. A missing track
 * stays placed, as a movies file does: likes and playlists keep pointing at it. Reads 2.
 */
export const placeTrack = async (
  db: DatabaseReader,
  trackId: Id<"tracks">,
  libraryOf: LibraryReader,
): Promise<PlacedItem | null> => {
  const track = await db.get(trackId);

  return track === null ? null : inMusic(libraryOf, track.libraryId, trackFacts(track));
};

/** An album placed in its music library, or null when it or its library is gone. Reads 2. */
export const placeAlbum = async (
  db: DatabaseReader,
  albumId: Id<"albums">,
  libraryOf: LibraryReader,
): Promise<PlacedItem | null> => {
  const album = await db.get(albumId);

  return album === null ? null : inMusic(libraryOf, album.libraryId, ALBUM_FACTS);
};

/**
 * A track's file revision as old music names it: its size and change time in base 36, which the
 * server's `ETag` for the original repeats, so a device resumes a download with `If-Range`.
 */
const fileRevision = (size: number, mtimeMs: number): string =>
  `${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}`;

/**
 * A track as a download describes it: its file as it is on disk, at every quality, as old music
 * kept downloads. A track a scan marked missing is not on disk, so it is gone until a scan finds
 * it again. Reads 2.
 */
export const trackSource: SourceLoader<"track"> = async (db, trackId, libraryOf) => {
  const track = await db.get(trackId);

  const placed =
    track === null || track.missing
      ? null
      : await inMusic(libraryOf, track.libraryId, trackFacts(track));

  if (track === null || placed === null) return null;

  return {
    library: placed.library._id,
    facts: placed.facts,
    resource: { kind: "track", id: track._id },
    revision: fileRevision(track.size, track.mtimeMs),
    bytes: () => track.size,
    label: track.title,
  };
};
