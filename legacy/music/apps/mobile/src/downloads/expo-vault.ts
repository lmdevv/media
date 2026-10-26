/**
 * The iPhone's vault: rows in SQLite and files beside them, in Application Support (which iOS
 * never purges, unlike Caches) and excluded from backup. One per server and account:
 * `<Application Support>/downloads/<server>/<account>/{vault.db, audio/, art/}`.
 */
import type { UserId } from "@music/commands/ids";
import type { SessionStore } from "@music/player/session-router";
import type { VaultStore } from "@music/sdk/downloads";
import { requireNativeModule } from "expo";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { openDatabaseAsync } from "expo-sqlite";

import { SESSION_TABLE, vaultSessions } from "./session-store";
import { commitVault, loadVault, prepareVault, readLyrics } from "./vault-rows";
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
  /** Where the player keeps its playback session across launches. */
  readonly session: SessionStore;
  readonly close: () => Promise<void>;
}

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
    await prepareVault(db);
    await db.execAsync(SESSION_TABLE);
  } catch (error) {
    await db.closeAsync();
    throw error;
  }

  return {
    load: () => loadVault(db),
    lyrics: (trackId) => readLyrics(db, trackId),
    commit: (change) => commitVault(db, change),
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
    session: vaultSessions(db),
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
