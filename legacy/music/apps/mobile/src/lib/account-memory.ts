import { UserId } from "@music/commands/ids";
import { Option, Schema } from "effect";

import { readValue, writeValue } from "./secure-storage";
import type { ServerOrigin } from "./server";

const decodeStored = Schema.decodeUnknownOption(UserId);

const accountKey = (origin: ServerOrigin): string =>
  `music.account.${Array.from(new TextEncoder().encode(origin), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

/** The account last signed in to on `origin`, or null when none is remembered for it. */
export const loadAccount = (origin: ServerOrigin): UserId | null =>
  Option.getOrNull(decodeStored(readValue(accountKey(origin))));

/** Remembers the account signed in to on `origin`, or forgets it with null. */
export const saveAccount = (origin: ServerOrigin, userId: UserId | null): void => {
  writeValue(accountKey(origin), userId);
};
