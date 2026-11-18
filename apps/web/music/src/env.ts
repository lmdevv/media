import { signInUrlFor } from "@media/sdk/promise";
import { Schema } from "effect";

const WebEnv = Schema.Struct({
  VITE_PLATFORM_URL: Schema.NonEmptyString,
  VITE_MEDIA_BASE_URL: Schema.optionalKey(Schema.String),
  VITE_SIGN_IN_URL: Schema.optionalKey(Schema.String),
});

const ENV = Schema.decodeUnknownSync(WebEnv)(import.meta.env);

/** The core deployment this client talks to, the same one the account client at `/` uses. */
export const PLATFORM_URL = ENV.VITE_PLATFORM_URL;

const configuredMediaUrl = ENV.VITE_MEDIA_BASE_URL?.replace(/\/+$/u, "") ?? "";

/** Where artwork and media requests go: the configured media service, or this app's origin. */
export const MEDIA_BASE_URL =
  configuredMediaUrl === "" ? window.location.origin : configuredMediaUrl;

const configuredSignInUrl = ENV.VITE_SIGN_IN_URL ?? "";

/**
 * Where this client signs in: the media server's sign-in boundary (ADR 0007), or the configured
 * one in development, where the stack runs the boundary alone (`scripts/dev-stack.sh`).
 */
export const SIGN_IN_URL =
  configuredSignInUrl === "" ? signInUrlFor(MEDIA_BASE_URL) : configuredSignInUrl;
