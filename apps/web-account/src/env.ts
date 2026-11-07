import { Schema } from "effect";

const AccountEnv = Schema.Struct({ VITE_PLATFORM_URL: Schema.NonEmptyString });

/** The core deployment this client talks to. */
export const PLATFORM_URL = Schema.decodeUnknownSync(AccountEnv)(import.meta.env).VITE_PLATFORM_URL;
