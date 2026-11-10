import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_PLATFORM_URL: Schema.NonEmptyString,
  VITE_MEDIA_BASE_URL: Schema.optionalKey(Schema.String),
});

const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);

/** The core deployment this client talks to, the same one the account client at `/` uses. */
export const PLATFORM_URL = ENV.VITE_PLATFORM_URL;

const configuredMediaUrl = ENV.VITE_MEDIA_BASE_URL?.replace(/\/+$/u, "") ?? "";

/** Where artwork and media requests go: the configured media service, or this app's origin. */
export const MEDIA_BASE_URL =
  configuredMediaUrl === "" ? window.location.origin : configuredMediaUrl;
