/** The server connection this install remembers, kept in the keychain. */
import { Option, Schema } from "effect";

import { readValue, writeValue } from "./secure-storage";
import { ServerConnection } from "./server";

const StoredConnection = Schema.fromJsonString(ServerConnection);

const KEY = "music.server";

const decodeStored = Schema.decodeUnknownOption(StoredConnection);

const encodeStored = Schema.encodeSync(StoredConnection);

/** The connection this install remembers, if any. */
export const loadConnection = (): ServerConnection | null =>
  Option.getOrNull(decodeStored(readValue(KEY)));

/** Remembers a connection, or forgets it with null. */
export const saveConnection = (connection: ServerConnection | null): void => {
  writeValue(KEY, connection === null ? null : encodeStored(connection));
};
