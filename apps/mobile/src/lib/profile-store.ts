import { ProfileId } from "@media/contracts/ids";
import { Option, Schema } from "effect";

import { readValue, writeValue } from "./secure-storage";

const KEY = "movies.profile";

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

/** The profile this device last chose, if any. */
export const loadProfileChoice = (): ProfileId | null =>
  Option.getOrNull(decodeProfileId(readValue(KEY)));

/** Remembers the chosen profile, or forgets it with null. */
export const saveProfileChoice = (profileId: ProfileId | null): void => {
  writeValue(KEY, profileId);
};
