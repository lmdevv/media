/**
 * The vault's rows in its SQLite database: the tables, and reading and writing them as the rows
 * `DownloadSync` works with. Every row is parsed when read; one that doesn't parse is deleted.
 * Lyrics are listed without the lyrics themselves, which are read one song at a time to show them.
 */
import { DownloadPinId, TrackId } from "@music/commands/ids";
import { LyricsRevision, OfflineLyrics } from "@music/commands/lyrics";
import {
  DownloadPin,
  DownloadTarget,
  ManifestEntryState,
  OfflineTrack,
  StreamProfile,
} from "@music/commands/models";
import { VaultChange } from "@music/sdk/downloads";
import type {
  KeptLyrics,
  NewLyrics,
  StoredArt,
  StoredCopy,
  StoredLyrics,
  StoredPin,
  VaultRows,
} from "@music/sdk/downloads";
import { Option, Schema } from "effect";

/** A row as SQLite returns it, before it is parsed. */
type SqlRow = Readonly<Record<string, string | number | null>>;

type SqlParams = Array<string | number | null>;

/** The part of an expo-sqlite database the vault's rows use. */
export interface VaultDatabase {
  readonly execAsync: (sql: string) => Promise<void>;
  readonly getAllAsync: (sql: string, params: SqlParams) => Promise<ReadonlyArray<SqlRow>>;
  readonly runAsync: (sql: string, params: SqlParams) => Promise<object>;
}

/** Lyrics rows one statement writes or deletes, well under SQLite's limit on parameters. */
const LYRICS_PER_STATEMENT = 100;

/**
 * The vault's tables. Each is created when missing, so a vault an older app made gains the tables
 * added since (lyrics) when it opens, keeping what it holds.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS copies (
  track_id TEXT PRIMARY KEY NOT NULL,
  rev TEXT NOT NULL,
  profile TEXT NOT NULL,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  art_hash TEXT,
  track TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  pin_id TEXT PRIMARY KEY NOT NULL,
  pin TEXT NOT NULL,
  members TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS art (
  hash TEXT PRIMARY KEY NOT NULL,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS removals (
  target_key TEXT PRIMARY KEY NOT NULL,
  target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lyrics (
  track_id TEXT PRIMARY KEY NOT NULL,
  rev TEXT NOT NULL,
  lyrics TEXT NOT NULL,
  bytes INTEGER NOT NULL
);
`;

const CopyRow = Schema.Struct({
  track_id: TrackId,
  rev: Schema.String,
  profile: StreamProfile,
  file: Schema.String,
  bytes: Schema.Finite,
  art_hash: Schema.NullOr(Schema.String),
  track: Schema.fromJsonString(OfflineTrack),
});

const PinRow = Schema.Struct({
  pin_id: DownloadPinId,
  pin: Schema.fromJsonString(DownloadPin),
  members: Schema.fromJsonString(
    Schema.Array(Schema.Struct({ trackId: TrackId, state: ManifestEntryState })),
  ),
});

const ArtRow = Schema.Struct({ hash: Schema.String, file: Schema.String, bytes: Schema.Finite });

const RemovalRow = Schema.Struct({
  target_key: Schema.String,
  target: Schema.fromJsonString(DownloadTarget),
});

const lyricsFields = {
  track_id: TrackId,
  rev: LyricsRevision,
  lyrics: Schema.fromJsonString(OfflineLyrics),
  bytes: Schema.Finite,
};

const LyricsRow = Schema.Struct(lyricsFields);

/** A lyrics row as the vault lists it, without the lyrics. */
const LyricsListing = Schema.Struct({
  track_id: lyricsFields.track_id,
  rev: lyricsFields.rev,
  bytes: lyricsFields.bytes,
});

/** A lyrics row as it is read to show it. */
const LyricsBody = Schema.Struct({ rev: lyricsFields.rev, lyrics: lyricsFields.lyrics });

const decodeCopy = Schema.decodeUnknownOption(CopyRow);

const decodePin = Schema.decodeUnknownOption(PinRow);

const decodeArt = Schema.decodeUnknownOption(ArtRow);

const decodeRemoval = Schema.decodeUnknownOption(RemovalRow);

const decodeListing = Schema.decodeUnknownOption(LyricsListing);

const decodeBody = Schema.decodeUnknownOption(LyricsBody);

const encodeRemoval = Schema.encodeSync(RemovalRow);

const encodeCopy = Schema.encodeSync(CopyRow);

const encodePin = Schema.encodeSync(PinRow);

const encodeLyrics = Schema.encodeSync(LyricsRow);

/** Creates the tables a vault lacks. Run each time the vault opens. */
export const prepareVault = (db: VaultDatabase): Promise<void> => db.execAsync(SCHEMA);

/** Rows read with `decode`; a row that doesn't parse is deleted, and its file swept later. */
const readRows = async <Row>(
  db: VaultDatabase,
  table: "copies" | "pins" | "art" | "removals" | "lyrics",
  key: "track_id" | "pin_id" | "hash" | "target_key",
  decode: (row: SqlRow) => Option.Option<Row>,
  columns = "*",
): Promise<ReadonlyArray<Row>> => {
  const rows = await db.getAllAsync(`SELECT ${columns} FROM ${table}`, []);

  const parsed: Array<Row> = [];
  const broken: Array<string | number | null> = [];

  for (const row of rows) {
    Option.match(decode(row), {
      onNone: () => broken.push(row[key] ?? null),
      onSome: (value) => parsed.push(value),
    });
  }

  await Promise.all(broken.map((id) => db.runAsync(`DELETE FROM ${table} WHERE ${key} = ?`, [id])));

  return parsed;
};

/** Every row the vault holds, lyrics without the lyrics themselves. */
export const loadVault = async (db: VaultDatabase): Promise<VaultRows> => {
  const [copies, pins, art, removals, lyrics] = await Promise.all([
    readRows(db, "copies", "track_id", decodeCopy),
    readRows(db, "pins", "pin_id", decodePin),
    readRows(db, "art", "hash", decodeArt),
    readRows(db, "removals", "target_key", decodeRemoval),
    readRows(db, "lyrics", "track_id", decodeListing, "track_id, rev, bytes"),
  ]);

  return {
    copies: new Map(
      copies.map((row): [TrackId, StoredCopy] => [
        row.track_id,
        {
          track: row.track,
          rev: row.rev,
          profile: row.profile,
          file: row.file,
          bytes: row.bytes,
          artHash: row.art_hash,
        },
      ]),
    ),
    pins: new Map(
      pins.map((row): [DownloadPinId, StoredPin] => [
        row.pin_id,
        { pin: row.pin, members: row.members },
      ]),
    ),
    art: new Map(art.map((row): [string, StoredArt] => [row.hash, row])),
    removals: new Map(
      removals.map((row): [string, DownloadTarget] => [row.target_key, row.target]),
    ),
    lyrics: new Map(
      lyrics.map((row): [TrackId, StoredLyrics] => [
        row.track_id,
        { trackId: row.track_id, rev: row.rev, bytes: row.bytes },
      ]),
    ),
  };
};

/**
 * The lyrics the vault keeps for `trackId`, or null when it keeps none. Lyrics that no longer
 * read as lyrics are deleted, and read as none.
 */
export const readLyrics = async (
  db: VaultDatabase,
  trackId: TrackId,
): Promise<KeptLyrics | null> => {
  const [row] = await db.getAllAsync("SELECT rev, lyrics FROM lyrics WHERE track_id = ?", [
    trackId,
  ]);

  if (row === undefined) return null;

  return Option.match(decodeBody(row), {
    onSome: (kept) => Promise.resolve(kept),
    onNone: async () => {
      await db.runAsync("DELETE FROM lyrics WHERE track_id = ?", [trackId]);

      return null;
    },
  });
};

/** `items` in runs of `LYRICS_PER_STATEMENT`. */
const statementsOf = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<ReadonlyArray<Item>> =>
  Array.from({ length: Math.ceil(items.length / LYRICS_PER_STATEMENT) }, (_, index) =>
    items.slice(index * LYRICS_PER_STATEMENT, (index + 1) * LYRICS_PER_STATEMENT),
  );

/** Writes songs' lyrics, a statement per `LYRICS_PER_STATEMENT` songs. */
const putLyrics = async (db: VaultDatabase, lyrics: ReadonlyArray<NewLyrics>): Promise<void> => {
  await statementsOf(lyrics).reduce(async (previous, part) => {
    await previous;

    const params = part.flatMap((kept) => {
      const row = encodeLyrics({
        track_id: kept.trackId,
        rev: kept.rev,
        lyrics: kept.lyrics,
        bytes: kept.bytes,
      });

      return [row.track_id, row.rev, row.lyrics, row.bytes];
    });

    await db.runAsync(
      `INSERT OR REPLACE INTO lyrics (track_id, rev, lyrics, bytes) VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}`,
      params,
    );
  }, Promise.resolve());
};

/** Deletes songs' lyrics, a statement per `LYRICS_PER_STATEMENT` songs. */
const deleteLyrics = async (db: VaultDatabase, trackIds: ReadonlyArray<TrackId>): Promise<void> => {
  await statementsOf(trackIds).reduce(async (previous, part) => {
    await previous;
    await db.runAsync(`DELETE FROM lyrics WHERE track_id IN (${part.map(() => "?").join(", ")})`, [
      ...part,
    ]);
  }, Promise.resolve());
};

/** Applies one change to the vault's rows. */
export const commitVault = async (db: VaultDatabase, change: VaultChange): Promise<void> => {
  await VaultChange.$match(change, {
    PutPin: ({ pin }) => {
      const row = encodePin({ pin_id: pin.pin.id, pin: pin.pin, members: pin.members });

      return db.runAsync("INSERT OR REPLACE INTO pins (pin_id, pin, members) VALUES (?, ?, ?)", [
        row.pin_id,
        row.pin,
        row.members,
      ]);
    },
    DeletePin: ({ pinId }) => db.runAsync("DELETE FROM pins WHERE pin_id = ?", [pinId]),
    PutCopy: ({ copy }) => {
      const row = encodeCopy({
        track_id: copy.track.id,
        rev: copy.rev,
        profile: copy.profile,
        file: copy.file,
        bytes: copy.bytes,
        art_hash: copy.artHash,
        track: copy.track,
      });

      return db.runAsync(
        "INSERT OR REPLACE INTO copies (track_id, rev, profile, file, bytes, art_hash, track) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [row.track_id, row.rev, row.profile, row.file, row.bytes, row.art_hash, row.track],
      );
    },
    UpdateCopy: ({ copy }) => {
      const row = encodeCopy({
        track_id: copy.track.id,
        rev: copy.rev,
        profile: copy.profile,
        file: copy.file,
        bytes: copy.bytes,
        art_hash: copy.artHash,
        track: copy.track,
      });

      return db.runAsync(
        "UPDATE copies SET rev = ?, profile = ?, bytes = ?, art_hash = ?, track = ? WHERE track_id = ? AND file = ?",
        [row.rev, row.profile, row.bytes, row.art_hash, row.track, row.track_id, row.file],
      );
    },
    DeleteCopy: ({ trackId, file }) =>
      db.runAsync("DELETE FROM copies WHERE track_id = ? AND file = ?", [trackId, file]),
    PutArt: ({ art }) =>
      db.runAsync("INSERT OR REPLACE INTO art (hash, file, bytes) VALUES (?, ?, ?)", [
        art.hash,
        art.file,
        art.bytes,
      ]),
    DeleteArt: ({ hash }) => db.runAsync("DELETE FROM art WHERE hash = ?", [hash]),
    PutRemoval: ({ key, target }) => {
      const row = encodeRemoval({ target_key: key, target });

      return db.runAsync("INSERT OR REPLACE INTO removals (target_key, target) VALUES (?, ?)", [
        row.target_key,
        row.target,
      ]);
    },
    DeleteRemoval: ({ key }) => db.runAsync("DELETE FROM removals WHERE target_key = ?", [key]),
    PutLyrics: ({ lyrics }) => putLyrics(db, lyrics),
    DeleteLyrics: ({ trackIds }) => deleteLyrics(db, trackIds),
  });
};
