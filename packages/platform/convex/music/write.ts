import type { WithoutSystemFields } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { artHashWithin, fingerprint, fitAlbum, fitArtist, fitTrack, labelWithin } from "./fit";
import type { LocalLyricSet } from "./validators";

/**
 * The only writer of the music tables: every insert, patch, and delete of an artist, album,
 * track, or lyrics row goes through here, and each keeps the document within its bound in
 * `fit.ts` (ADR 0024), so reads may reserve those bounds (ADR 0005). The writer sets each new
 * row's tie. Counts and totals move in `catalog.ts`, the one caller that changes which tracks a
 * library holds.
 */

type Db = MutationCtx["db"];

type Table = "artists" | "albums" | "tracks";

type Fields<T extends Table> = Omit<WithoutSystemFields<Doc<T>>, "tie">;

/** A row as the writer stored it, which a call keeps instead of reading it again. */
export type Stored<T extends Table> = Omit<Doc<T>, "_creationTime">;

/** A tie for a new row: unique, and never changed after its insert (ADR 0005). */
const newTie = (): string => crypto.randomUUID();

export const insertArtist = async (
  db: Db,
  fields: Fields<"artists">,
): Promise<Stored<"artists">> => {
  const stored = fitArtist({ ...fields, tie: newTie() });

  return { ...stored, _id: await db.insert("artists", stored) };
};

export const setArtistArt = (db: Db, id: Id<"artists">, artHash: string | null) =>
  db.patch(id, { artHash: artHashWithin(artHash) });

export const setArtistAlbums = (db: Db, id: Id<"artists">, albumCount: number) =>
  db.patch(id, { albumCount });

export const deleteArtist = (db: Db, id: Id<"artists">): Promise<void> => db.delete(id);

export const insertAlbum = async (db: Db, fields: Fields<"albums">): Promise<Stored<"albums">> => {
  const stored = fitAlbum({ ...fields, tie: newTie() });

  return { ...stored, _id: await db.insert("albums", stored) };
};

/** Writes an album's artwork, and the year and genre a later track filled in. */
export const setAlbumTags = (
  db: Db,
  id: Id<"albums">,
  tags: Pick<Fields<"albums">, "artHash" | "year" | "genre">,
) =>
  db.patch(id, {
    artHash: artHashWithin(tags.artHash),
    year: tags.year,
    genre: labelWithin(tags.genre),
  });

export const setAlbumCounts = (
  db: Db,
  id: Id<"albums">,
  counts: Pick<Fields<"albums">, "trackCount" | "durationMs">,
) => db.patch(id, counts);

export const deleteAlbum = (db: Db, id: Id<"albums">): Promise<void> => db.delete(id);

export const insertTrack = (db: Db, fields: Fields<"tracks">): Promise<Id<"tracks">> =>
  db.insert("tracks", fitTrack({ ...fields, tie: newTie() }));

/** Writes every field of a track but its tie, as a scan read the file again. */
export const writeTrack = (db: Db, id: Id<"tracks">, fields: Fields<"tracks">) =>
  db.patch(id, fitTrack(fields));

export const setTrackMissing = (db: Db, id: Id<"tracks">) => db.patch(id, { missing: true });

/** Moves a track to `path`, which a scan keeps within the filesystem's 4,096 bytes. */
export const setTrackPath = (db: Db, id: Id<"tracks">, path: string) => db.patch(id, { path });

/** Writes what a track keeps about its own lyrics. */
export const setTrackLyrics = (
  db: Db,
  id: Id<"tracks">,
  lyrics: Pick<
    Fields<"tracks">,
    "lyricsFiles" | "lyricsReader" | "lyricsBytes" | "lyricsHash" | "lyricsSynced"
  >,
) => db.patch(id, { ...lyrics, lyricsFiles: fingerprint(lyrics.lyricsFiles) });

export const deleteTrack = (db: Db, id: Id<"tracks">): Promise<void> => db.delete(id);

/**
 * Makes `sets`, already fitted (`fitLyrics`), a track's own lyrics. `stored` is whether the track
 * has a lyrics row now, which its `lyricsBytes` says; without one and with no sets, nothing is
 * read. With no sets the row goes, and the same sets again change nothing, so a retried batch
 * converges.
 */
export const writeLyrics = async (
  db: Db,
  trackId: Id<"tracks">,
  stored: boolean,
  sets: ReadonlyArray<LocalLyricSet>,
): Promise<void> => {
  if (!stored && sets.length === 0) return;

  const row = stored
    ? await db
        .query("localLyrics")
        .withIndex("by_track", (q) => q.eq("trackId", trackId))
        .first()
    : null;

  if (row === null) {
    if (sets.length > 0) await db.insert("localLyrics", { trackId, sets: [...sets] });

    return;
  }

  if (sets.length === 0) await db.delete(row._id);
  else if (JSON.stringify(row.sets) !== JSON.stringify(sets)) {
    await db.patch(row._id, { sets: [...sets] });
  }
};
