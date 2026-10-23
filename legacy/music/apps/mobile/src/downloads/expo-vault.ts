/**
 * The iPhone's vault: rows in SQLite and files beside them, in Application Support (which iOS
 * never purges, unlike Caches) and excluded from backup. One per server and account:
 * `<Application Support>/downloads/<server>/<account>/{vault.db, audio/, art/}`.
 */
import { DownloadPinId, TrackId } from "@music/commands/ids";
import type { UserId } from "@music/commands/ids";
import {
  DownloadPin,
  DownloadTarget,
  ManifestEntryState,
  OfflineTrack,
  StreamProfile,
} from "@music/commands/models";
import { VaultChange } from "@music/sdk/downloads";
import type { StoredArt, StoredCopy, StoredPin, VaultRows, VaultStore } from "@music/sdk/downloads";
import { Option, Schema } from "effect";
import { requireNativeModule } from "expo";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";

import type { ServerOrigin } from "../lib/server";

/**
 * Marks a directory, and so everything in it, excluded from backup (`modules/vault-files`). Looked
 * up when a vault opens, so a build without the module fails downloads, not the app's start.
 */
const excludeFromBackup = (directory: Directory): void => {
  requireNativeModule<{ excludeFromBackup: (uri: string) => void }>("VaultFiles").excludeFromBackup(
    directory.uri,
  );
};

/** The vault's subdirectories for files. */
const FILE_DIRECTORIES = ["audio", "art"] as const;

/** A wiped server's directory is renamed to this prefix, then deleted. */
const WIPED = "wiped-";

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

const decodeCopy = Schema.decodeUnknownOption(CopyRow);

const decodePin = Schema.decodeUnknownOption(PinRow);

const decodeArt = Schema.decodeUnknownOption(ArtRow);

const decodeRemoval = Schema.decodeUnknownOption(RemovalRow);

const encodeRemoval = Schema.encodeSync(RemovalRow);

const encodeCopy = Schema.encodeSync(CopyRow);

const encodePin = Schema.encodeSync(PinRow);

/** Every download on this iPhone, for all servers. */
const downloadsDirectory = (): Directory =>
  new Directory(Paths.document.parentDirectory, "Library", "Application Support", "downloads");

/** A directory name for a server: its origin's hash, so any origin makes a safe name. */
const serverDirectory = async (origin: ServerOrigin): Promise<Directory> => {
  const hash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, origin);

  return new Directory(downloadsDirectory(), hash.slice(0, 32));
};

/** A vault this app opened; close it before its account's downloads are wiped. */
export interface ExpoVault extends VaultStore {
  readonly close: () => Promise<void>;
}

/** A row as SQLite returns it, before it is parsed. */
type SqlRow = Readonly<Record<string, string | number | null>>;

/** Rows read with `decode`; a row that doesn't parse is deleted, and its file swept later. */
const readRows = async <Row>(
  db: SQLiteDatabase,
  table: "copies" | "pins" | "art" | "removals",
  key: "track_id" | "pin_id" | "hash" | "target_key",
  decode: (row: SqlRow) => Option.Option<Row>,
): Promise<ReadonlyArray<Row>> => {
  const rows = await db.getAllAsync<SqlRow>(`SELECT * FROM ${table}`);

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

const load = async (db: SQLiteDatabase): Promise<VaultRows> => {
  const [copies, pins, art, removals] = await Promise.all([
    readRows(db, "copies", "track_id", decodeCopy),
    readRows(db, "pins", "pin_id", decodePin),
    readRows(db, "art", "hash", decodeArt),
    readRows(db, "removals", "target_key", decodeRemoval),
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
  };
};

const commit = async (db: SQLiteDatabase, change: VaultChange): Promise<void> => {
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
  });
};

/** A vault file as `File`; vault files are named `<directory>/<name>`. */
const fileIn = (vault: Directory, file: string): File => new File(vault, ...file.split("/"));

/**
 * Deletes servers' directories a wipe renamed but didn't finish deleting. Each is tried on its
 * own; one that can't go yet is tried again at the next open or wipe.
 */
const sweepWiped = (downloads: Directory): void => {
  for (const entry of downloads.list()) {
    if (!(entry instanceof Directory) || !entry.name.startsWith(WIPED)) continue;

    try {
      entry.delete();
    } catch {
      // Left for the next sweep.
    }
  }
};

/**
 * Opens the vault of `account` on the server at `origin`, creating it on first use. The
 * downloads directory is marked excluded from backup each time, which is idempotent.
 */
export const openVault = async (origin: ServerOrigin, account: UserId): Promise<ExpoVault> => {
  const downloads = downloadsDirectory();
  downloads.create({ intermediates: true, idempotent: true });
  excludeFromBackup(downloads);
  sweepWiped(downloads);
  const vault = new Directory(await serverDirectory(origin), account);

  for (const name of FILE_DIRECTORIES) {
    new Directory(vault, name).create({ intermediates: true, idempotent: true });
  }

  const db = await openDatabaseAsync("vault.db", undefined, vault.uri);

  try {
    await db.execAsync(SCHEMA);
  } catch (error) {
    await db.closeAsync();
    throw error;
  }

  return {
    load: () => load(db),
    commit: (change) => commit(db, change),
    // Async, so a file system error rejects rather than throwing at the caller.
    files: async () =>
      FILE_DIRECTORIES.flatMap((name) =>
        new Directory(vault, name)
          .list()
          .flatMap((entry) => (entry instanceof File ? [`${name}/${entry.name}`] : [])),
      ),
    uri: (file) => fileIn(vault, file).uri,
    remove: async (file) => {
      const found = fileIn(vault, file);

      if (found.exists) found.delete();
    },
    size: async (file) => {
      const found = fileIn(vault, file);

      return found.exists ? found.size : null;
    },
    freeBytes: () => Paths.availableDiskSpace,
    close: () => db.closeAsync(),
  };
};

/**
 * Deletes every download kept for the server at `origin`: files and rows, for any account. Its
 * directory is renamed away first, so a delete that fails leaves nothing a vault opens again. Stop
 * the server's sync and close its vault first: an iOS download task in flight re-creates its
 * directories and would land its file at the old path.
 */
export const wipeVaults = async (origin: ServerOrigin): Promise<void> => {
  const server = await serverDirectory(origin);

  if (!server.exists) return;
  // A unique name: an earlier wipe's directory may still be waiting to be deleted.
  server.rename(`${WIPED}${server.name}-${randomUUID()}`);
  sweepWiped(downloadsDirectory());
};
