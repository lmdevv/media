import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_CONVEX_URL: Schema.NonEmptyString,
});

export const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);
