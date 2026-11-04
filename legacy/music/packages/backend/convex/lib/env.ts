import { fail } from "./errors";

/** Reads a required deployment environment variable. */
export const requireEnv = (name: "STREAM_SIGNING_KEY" | "MEDIA_SERVICE_SECRET"): string => {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    return fail("internal", `${name} is not set on this deployment`);
  }

  return value;
};

/** Public base path of the media service, `/media` behind Caddy. */
export const mediaBaseUrl = (): string => process.env.MEDIA_PUBLIC_URL ?? "/media";
