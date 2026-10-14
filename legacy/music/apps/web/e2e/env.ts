import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webEnv = fileURLToPath(new URL("../.env.local", import.meta.url));

const mediaEnv = fileURLToPath(new URL("../../media/.env.local", import.meta.url));

/** The value of `name=` in an env file, if the file and the line exist. */
const envValue = (file: string, name: string): string | undefined =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((entry) => entry.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim()
    : undefined;

/**
 * The port the backend expects the media service on: `PORT` in apps/media/.env.local, which
 * `scripts/dev-backend.sh` writes along with the media URL it configures, else the default 4100.
 */
export const e2eMediaPort = (): number => Number(envValue(mediaEnv, "PORT") ?? "4100");

/** The default `scripts/dev-backend.sh` backend, used when nothing else is configured. */
const DEV_BACKEND = "http://127.0.0.1:3210";

/**
 * The backend the tests use: E2E_CONVEX_URL, else the dev backend in apps/web/.env.local, else
 * the default dev backend (so tools that load the Playwright config never fail on a clean clone).
 */
export const e2eConvexUrl = (): string => {
  const explicit = process.env["E2E_CONVEX_URL"];

  if (explicit !== undefined && explicit.length > 0) return explicit;

  if (!existsSync(webEnv)) return DEV_BACKEND;

  const url = envValue(webEnv, "VITE_CONVEX_URL");

  if (url === undefined) throw new Error("Set E2E_CONVEX_URL or run scripts/dev-backend.sh first");

  return url;
};
