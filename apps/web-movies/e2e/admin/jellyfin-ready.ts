import { Schema } from "effect";

const JellyfinReady = Schema.Struct({
  url: Schema.String,
  apiKey: Schema.String,
  version: Schema.String,
});

/**
 * Parses the line the Jellyfin source script prints when it is ready.
 *
 * @throws When the line is not the script's ready line, a harness defect.
 */
export const parseJellyfinReady = Schema.decodeUnknownSync(Schema.fromJsonString(JellyfinReady));
