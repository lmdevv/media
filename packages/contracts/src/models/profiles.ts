import { Schema } from "effect";

import { AgeRating } from "../content-rating";
import { ProfileId } from "../ids";
import { EpochMillis } from "../units";

/** A viewing profile. */
export const Profile = Schema.Struct({
  id: ProfileId,
  name: Schema.String,
  avatar: Schema.String,
  kids: Schema.Boolean,
  /** The highest age rating this profile sees; null means unrestricted. */
  maxAgeRating: Schema.NullOr(AgeRating),
  hasPin: Schema.Boolean,
  /** The profile has a PIN that this session has not unlocked yet. */
  locked: Schema.Boolean,
  createdAt: EpochMillis,
});

/** A viewing profile. */
export interface Profile extends Schema.Schema.Type<typeof Profile> {}
