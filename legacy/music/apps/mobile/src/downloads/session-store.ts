/**
 * The playback session a phone keeps across launches, in its vault's database: the session it
 * played without the server and has not handed back yet, and the server's session as it last saw
 * it, which a launch with no connection starts from. Signing out wipes the vault, and with it these.
 */
import { PlaybackState } from "@music/commands/models";
import { LocalSessionState } from "@music/player/local-session";
import type { SessionStore } from "@music/player/session-router";
import { Option, Schema } from "effect";

/** One row per session: `local` and `server`. */
export const SESSION_TABLE = `
CREATE TABLE IF NOT EXISTS session (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL
);
`;

/** The part of an expo-sqlite database the store uses. */
export interface SessionDatabase {
  readonly getAllAsync: (sql: string) => Promise<ReadonlyArray<object>>;
  readonly runAsync: (sql: string, params: Array<string>) => Promise<object>;
}

const SessionRow = Schema.Struct({ key: Schema.String, state: Schema.String });

const StoredLocal = Schema.fromJsonString(LocalSessionState);

const StoredServer = Schema.fromJsonString(PlaybackState);

const decodeRow = Schema.decodeUnknownOption(SessionRow);

const decodeLocal = Schema.decodeUnknownOption(StoredLocal);

const decodeServer = Schema.decodeUnknownOption(StoredServer);

const encodeLocal = Schema.encodeSync(StoredLocal);

const encodeServer = Schema.encodeSync(StoredServer);

type SessionKey = "local" | "server";

const save = async (db: SessionDatabase, key: SessionKey, state: string | null): Promise<void> => {
  await (state === null
    ? db.runAsync("DELETE FROM session WHERE key = ?", [key])
    : db.runAsync("INSERT OR REPLACE INTO session (key, state) VALUES (?, ?)", [key, state]));
};

/**
 * The session store over a vault's database. A row that no longer parses, from an older app or a
 * damaged file, reads as nothing stored.
 */
export const vaultSessions = (db: SessionDatabase): SessionStore => {
  // The server's session changes with every position report: one write at a time, and while one
  // runs only the newest snapshot waits for the next.
  let writing: Promise<void> | null = null;
  let waiting: PlaybackState | null = null;

  const writeServer = async (): Promise<void> => {
    const state = waiting;

    if (state === null) {
      writing = null;

      return;
    }

    waiting = null;

    // A failed write still lets a newer snapshot through; the failure reaches the callers after.
    let failure: Error | null = null;

    try {
      await save(db, "server", encodeServer(state));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    await writeServer();

    if (failure !== null) throw failure;
  };

  return {
    load: async () => {
      const rows = (await db.getAllAsync("SELECT key, state FROM session")).flatMap((row) =>
        Option.toArray(decodeRow(row)),
      );

      const stored = (key: SessionKey): string | undefined =>
        rows.find((row) => row.key === key)?.state;

      return {
        local: Option.getOrNull(decodeLocal(stored("local"))),
        server: Option.getOrNull(decodeServer(stored("server"))),
      };
    },
    saveLocal: (state) => save(db, "local", state === null ? null : encodeLocal(state)),
    saveServer: (state) => {
      waiting = state;
      writing ??= writeServer();

      return writing;
    },
  };
};
