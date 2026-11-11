import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const readEnvFile = (path: string): ReadonlyMap<string, string> => {
  if (!existsSync(path)) return new Map();

  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");

        return separator > 0
          ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
          : [];
      }),
  );
};

const pick = (name: string, file: ReadonlyMap<string, string>): string | undefined =>
  process.env[name] ?? file.get(name);

/** What the stack suites need from `scripts/dev-stack.sh up`. */
export interface StackEnv {
  /** The core's Convex URL, which both web clients and the media service use. */
  readonly platformUrl: string;
  /** The core's admin key, for creating users as the server host does. */
  readonly adminKey: string;
  readonly mediaUrl: string;
  /** The movies dev server's port; it serves `/movies/` and passes the rest to the account's. */
  readonly webPort: number;
  /** The account client's dev server. */
  readonly accountUrl: string;
  /** The stack's sign-in boundary (`scripts/dev-stack.sh`), where every sign-in goes. */
  readonly signInUrl: string;
  /** The media service's environment as `scripts/dev-stack.sh` wrote it. */
  readonly mediaEnv: Readonly<Record<string, string>>;
}

/** The stack's settings, or null when this worktree has no stack. */
export const stackEnv = (): StackEnv | null => {
  const web = readEnvFile(`${repoRoot}apps/web-movies/.env.local`);
  const media = readEnvFile(`${repoRoot}apps/media/.env.local`);
  const platform = readEnvFile(`${repoRoot}packages/platform/.env.local`);

  const platformUrl = pick("VITE_PLATFORM_URL", web);
  const mediaUrl = pick("VITE_MEDIA_BASE_URL", web);
  const webPort = pick("WEB_PORT", web);
  const accountUrl = pick("ACCOUNT_DEV_URL", web);
  const signInUrl = pick("VITE_SIGN_IN_URL", web);
  const adminKey = platform.get("CONVEX_SELF_HOSTED_ADMIN_KEY");

  if (
    platformUrl === undefined ||
    mediaUrl === undefined ||
    webPort === undefined ||
    accountUrl === undefined ||
    signInUrl === undefined ||
    adminKey === undefined ||
    media.get("MEDIA_SERVICE_API_KEY") === undefined
  ) {
    return null;
  }

  return {
    platformUrl,
    adminKey,
    mediaUrl,
    webPort: Number(webPort),
    accountUrl,
    signInUrl,
    mediaEnv: Object.fromEntries(media),
  };
};
