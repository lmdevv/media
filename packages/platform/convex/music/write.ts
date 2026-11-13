import type {
  IndexNames,
  NamedTableInfo,
  PaginationOptions,
  PaginationResult,
  Query,
  QueryInitializer,
  WithoutSystemFields,
} from "convex/server";
import { getDocumentSize } from "convex/values";
import type { Value } from "convex/values";

import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { paginate } from "../core/lib/paginate";
import type { IndexedList } from "../core/lib/paginate";
import { cost } from "./budget";
import type { Cost, Meter } from "./budget";
import {
  TABLE_BYTES,
  artHashWithin,
  fingerprint,
  fitAlbum,
  fitArtist,
  fitTrack,
  labelWithin,
} from "./fit";
import type { musicTables } from "./schema";
import { moveTotals } from "./totals";
import type { Moved } from "./totals";
import type { LocalLyricSet } from "./validators";

/**
 * The music store: the only module that reads or writes the music tables in a mutation that
 * writes them. Every insert, patch, and delete goes through here, and each keeps the document
 * within its bound in `fit.ts` (ADR 0024), so reads may reserve those bounds (ADR 0005). The store
 * sets each new row's tie. It charges its meter for each read and write as it makes it, at the
 * size of the documents Convex reads: a query reads each document it returns, and a patch or a
 * delete reads the document again before it writes. A caller holds no other database handle for
 * the music tables, so no read or write goes uncharged. `catalog.ts` decides counts and totals:
 * it is the one caller that changes which tracks a library holds.
 */

type Db = MutationCtx["db"];

export type MusicTable = keyof typeof musicTables;

type Info<T extends MusicTable> = NamedTableInfo<DataModel, T>;

/** A query over one music table, built from its start. */
export type Select<T extends MusicTable> = (table: QueryInitializer<Info<T>>) => Query<Info<T>>;

type Fields<T extends "artists" | "albums" | "tracks"> = Omit<WithoutSystemFields<Doc<T>>, "tie">;

/** Fields a patch writes, as Convex's `db.patch` takes them: `undefined` removes a field. */
type Patch<Document> = {
  [Field in keyof Document]?: undefined extends Document[Field]
    ? Document[Field] | undefined
    : Document[Field];
};

/** A row as the store wrote it, which a call keeps instead of reading it again. */
export type Stored<T extends "artists" | "albums" | "tracks"> = Omit<Doc<T>, "_creationTime">;

/** Reading `bytes` of documents through one index range. */
const readCost = (bytes: number): Cost => cost(1, 0, bytes);

const insertCost = (bytes: number): Cost => cost(0, 1, 0, bytes);

/** Patching a document of `before` bytes into one of `after`: Convex reads it, then writes it. */
const patchCost = (before: number, after: number): Cost => cost(1, 1, before, after);

/** Deleting a document of `bytes`: Convex reads it, then writes its removal. */
const deleteCost = (bytes: number): Cost => cost(1, 1, bytes, 0);

/** What store work costs at most, with every document at its table's bound (`fit.ts`). */
export const atBound = {
  read: (table: MusicTable, rows = 1): Cost => readCost(rows * TABLE_BYTES[table]),
  patch: (table: MusicTable): Cost => patchCost(TABLE_BYTES[table], TABLE_BYTES[table]),
  delete: (table: MusicTable): Cost => deleteCost(TABLE_BYTES[table]),
} as const;

/** A counter shard row of a library's totals, in Convex's measure: a short name and two numbers. */
const COUNTER_BYTES = 256;

/** Moving a library's three totals: each reads one shard and patches or inserts it. */
const TOTALS_COST = cost(6, 3, 3 * 2 * COUNTER_BYTES, 3 * COUNTER_BYTES);

/** A tie for a new row: unique, and never changed after its insert (ADR 0005). */
const newTie = (): string => crypto.randomUUID();

export interface MusicStore {
  /** What the store's mutation has spent, every read and write of the store charged. */
  readonly meter: Meter;
  readonly get: <T extends MusicTable>(table: T, id: Id<T>) => Promise<Doc<T> | null>;
  readonly first: <T extends MusicTable>(table: T, select: Select<T>) => Promise<Doc<T> | null>;
  /** The one row a query finds, or null; a second row is a defect, and throws. */
  readonly unique: <T extends MusicTable>(table: T, select: Select<T>) => Promise<Doc<T> | null>;
  readonly take: <T extends MusicTable>(
    table: T,
    select: Select<T>,
    count: number,
  ) => Promise<ReadonlyArray<Doc<T>>>;
  /** A page of a list, as `core/lib/paginate.ts` reads it. */
  readonly paginate: <T extends MusicTable, Index extends IndexNames<Info<T>>>(
    list: IndexedList<T, Index>,
    options: PaginationOptions,
  ) => Promise<PaginationResult<Doc<T>>>;

  readonly insertArtist: (fields: Fields<"artists">) => Promise<Stored<"artists">>;
  readonly setArtistArt: (id: Id<"artists">, artHash: string | null) => Promise<void>;
  readonly setArtistAlbums: (id: Id<"artists">, albumCount: number) => Promise<void>;
  readonly deleteArtist: (id: Id<"artists">) => Promise<void>;

  readonly insertAlbum: (fields: Fields<"albums">) => Promise<Stored<"albums">>;
  /** Writes an album's artwork, and the year and genre a later track filled in. */
  readonly setAlbumTags: (
    id: Id<"albums">,
    tags: Pick<Fields<"albums">, "artHash" | "year" | "genre">,
  ) => Promise<void>;
  readonly setAlbumCounts: (
    id: Id<"albums">,
    counts: Pick<Fields<"albums">, "trackCount" | "durationMs">,
  ) => Promise<void>;
  readonly deleteAlbum: (id: Id<"albums">) => Promise<void>;

  readonly insertTrack: (fields: Fields<"tracks">) => Promise<Id<"tracks">>;
  /** Writes every field of a track but its tie, as a scan read the file again. */
  readonly writeTrack: (id: Id<"tracks">, fields: Fields<"tracks">) => Promise<void>;
  readonly setTrackMissing: (id: Id<"tracks">) => Promise<void>;
  /** Writes what a track keeps about its own lyrics. */
  readonly setTrackLyrics: (
    id: Id<"tracks">,
    lyrics: Pick<
      Fields<"tracks">,
      "lyricsFiles" | "lyricsReader" | "lyricsBytes" | "lyricsHash" | "lyricsSynced"
    >,
  ) => Promise<void>;
  readonly deleteTrack: (id: Id<"tracks">) => Promise<void>;
  /**
   * Makes `sets`, already fitted (`fitLyrics`), a track's own lyrics. `storedHash` is the
   * `lyricsHash` the track keeps of its lyrics row, null without one, and `hash` is the sets'
   * (`lyricsFieldsOf`). When they match, the row already holds the sets and nothing is read;
   * otherwise the row is read once, then replaced, deleted for no sets, or inserted. The same
   * sets again change nothing, so a retried batch converges.
   */
  readonly writeLyrics: (
    trackId: Id<"tracks">,
    storedHash: string | null,
    sets: ReadonlyArray<LocalLyricSet>,
    hash: string | null,
  ) => Promise<void>;

  /**
   * Moves a library's album, artist, and duration totals (`totals.ts`). It runs at a call's end,
   * after the batch's last item, so a call reserves it in the work it charges before its first.
   */
  readonly moveTotals: (libraryId: Id<"libraries">, moved: Moved) => Promise<void>;
}

/** The music store over `db`, charging `meter` for each read and write. */
export const musicStore = (db: Db, meter: Meter): MusicStore => {
  /**
   * The latest version of each document the store read or wrote, and its size, which a patch or
   * a delete reads again.
   */
  const known = new Map<string, { readonly doc: Record<string, Value>; readonly bytes: number }>();

  /** What Convex reads of the document `id` before it writes it: its bound when unknown. */
  const bytesOf = (table: MusicTable, id: string): number =>
    known.get(id)?.bytes ?? TABLE_BYTES[table];

  const read = (rows: ReadonlyArray<Record<string, Value> & { readonly _id: string }>): void => {
    const bytes = rows.reduce((sum, row) => {
      const size = getDocumentSize(row);

      known.set(row._id, { doc: row, bytes: size });

      return sum + size;
    }, 0);

    meter.charge(readCost(bytes));
  };

  const select = <T extends MusicTable>(table: T, query: Select<T>): Query<Info<T>> => {
    const start: QueryInitializer<Info<T>> = db.query(table);

    return query(start);
  };

  const take = async <T extends MusicTable>(table: T, query: Select<T>, count: number) => {
    const rows = await select(table, query).take(count);

    read(rows);

    return rows;
  };

  const insert = async <T extends MusicTable>(
    table: T,
    fields: WithoutSystemFields<Doc<T>>,
  ): Promise<Id<T>> => {
    const id = await db.insert(table, fields);
    const bytes = getDocumentSize(fields);

    known.set(id, { doc: { ...fields, _id: id }, bytes });
    meter.charge(insertCost(bytes));

    return id;
  };

  const patch = async <T extends MusicTable>(
    table: T,
    id: Id<T>,
    fields: Patch<Doc<T>>,
  ): Promise<void> => {
    const before = known.get(id);

    await db.patch(table, id, fields);

    if (before === undefined) {
      meter.charge(patchCost(TABLE_BYTES[table], TABLE_BYTES[table]));

      return;
    }

    const doc = { ...before.doc, ...fields };
    const bytes = getDocumentSize(doc);

    known.set(id, { doc, bytes });
    meter.charge(patchCost(before.bytes, bytes));
  };

  const remove = async <T extends MusicTable>(table: T, id: Id<T>): Promise<void> => {
    const bytes = bytesOf(table, id);

    await db.delete(table, id);
    known.delete(id);
    meter.charge(deleteCost(bytes));
  };

  return {
    meter,
    get: async (table, id) => {
      const row = await db.get(table, id);

      read(row === null ? [] : [row]);

      return row;
    },
    first: async (table, query) => (await take(table, query, 1))[0] ?? null,
    unique: async (table, query) => {
      const row = await select(table, query).unique();

      read(row === null ? [] : [row]);

      return row;
    },
    take,
    paginate: async (list, options) => {
      const found = await paginate(db, list, options);

      read(found.page);

      return found;
    },

    insertArtist: async (fields) => {
      const stored = fitArtist({ ...fields, tie: newTie() });

      return { ...stored, _id: await insert("artists", stored) };
    },
    setArtistArt: (id, artHash) => patch("artists", id, { artHash: artHashWithin(artHash) }),
    setArtistAlbums: (id, albumCount) => patch("artists", id, { albumCount }),
    deleteArtist: (id) => remove("artists", id),

    insertAlbum: async (fields) => {
      const stored = fitAlbum({ ...fields, tie: newTie() });

      return { ...stored, _id: await insert("albums", stored) };
    },
    setAlbumTags: (id, tags) =>
      patch("albums", id, {
        artHash: artHashWithin(tags.artHash),
        year: tags.year,
        genre: labelWithin(tags.genre),
      }),
    setAlbumCounts: (id, counts) => patch("albums", id, counts),
    deleteAlbum: (id) => remove("albums", id),

    insertTrack: (fields) => insert("tracks", fitTrack({ ...fields, tie: newTie() })),
    writeTrack: (id, fields) => patch("tracks", id, fitTrack(fields)),
    setTrackMissing: (id) => patch("tracks", id, { missing: true }),
    setTrackLyrics: (id, lyrics) =>
      patch("tracks", id, { ...lyrics, lyricsFiles: fingerprint(lyrics.lyricsFiles) }),
    deleteTrack: (id) => remove("tracks", id),
    writeLyrics: async (trackId, storedHash, sets, hash) => {
      if (storedHash === hash) return;

      const row =
        storedHash !== null
          ? (
              await take(
                "localLyrics",
                (q) => q.withIndex("by_track", (index) => index.eq("trackId", trackId)),
                1,
              )
            )[0]
          : undefined;

      if (row === undefined) {
        if (sets.length > 0) await insert("localLyrics", { trackId, sets: [...sets] });

        return;
      }

      if (sets.length === 0) await remove("localLyrics", row._id);
      else await patch("localLyrics", row._id, { sets: [...sets] });
    },

    moveTotals: async (libraryId, moved) => {
      await moveTotals(db, libraryId, moved);
      meter.charge(TOTALS_COST);
    },
  };
};
