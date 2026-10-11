/**
 * Settings shared by the harness scripts, the media stub, and the Playwright tests. Values come
 * from `apps/media/.env.local`, which `scripts/dev-backend.sh <name> <port>` writes.
 */
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const repoRoot = resolve(import.meta.dirname, "../../..");

const mediaEnvFile = join(repoRoot, "apps/media/.env.local");

const mediaEnv: Readonly<Record<string, string | undefined>> = existsSync(mediaEnvFile)
  ? parseEnv(readFileSync(mediaEnvFile, "utf8"))
  : {};

/** Where generated audio files live; also the library folder the seed registers. */
export const fixturesDir =
  process.env["MUSIC_FIXTURES_DIR"] ?? join(tmpdir(), "music-player-fixtures");

/** The media stub port. Matches the media URL Convex signs (`port + 890` of the backend). */
export const mediaPort = Number(mediaEnv["PORT"] ?? "4300");

/** The Vite harness port. */
export const harnessPort = Number(process.env["HARNESS_PORT"] ?? "5310");

/** The backend the stub and the seed talk to, or null when no dev backend is configured. */
export const backend =
  mediaEnv["CONVEX_URL"] === undefined ||
  mediaEnv["MEDIA_SERVICE_SECRET"] === undefined ||
  mediaEnv["STREAM_SIGNING_KEY"] === undefined
    ? null
    : {
        convexUrl: mediaEnv["CONVEX_URL"],
        mediaSecret: mediaEnv["MEDIA_SERVICE_SECRET"],
        signingKey: mediaEnv["STREAM_SIGNING_KEY"],
      };
