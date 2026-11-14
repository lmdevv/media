import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

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

/** What the suite needs from `scripts/dev-stack.sh up`. */
export interface StackEnv {
  readonly platformUrl: string;
  readonly adminKey: string;
  readonly mediaUrl: string;
  readonly signInUrl: string;
  /** The music dev server's port; it serves `/music/` and passes the rest to the account's. */
  readonly musicPort: number;
  readonly accountUrl: string;
  readonly mediaEnv: Readonly<Record<string, string>>;
}

/** The stack's settings, or null when this worktree has no stack. */
export const stackEnv = (): StackEnv | null => {
  const web = readEnvFile(join(repoRoot, "apps/web-music/.env.local"));
  const media = readEnvFile(join(repoRoot, "apps/media/.env.local"));
  const platform = readEnvFile(join(repoRoot, "packages/platform/.env.local"));
  const pick = (name: string): string | undefined => process.env[name] ?? web.get(name);
  const platformUrl = pick("VITE_PLATFORM_URL");
  const mediaUrl = pick("VITE_MEDIA_BASE_URL");
  const signInUrl = pick("VITE_SIGN_IN_URL");
  const musicPort = pick("MUSIC_PORT");
  const accountUrl = pick("ACCOUNT_DEV_URL");
  const adminKey = platform.get("CONVEX_SELF_HOSTED_ADMIN_KEY");

  if (
    platformUrl === undefined ||
    mediaUrl === undefined ||
    signInUrl === undefined ||
    musicPort === undefined ||
    accountUrl === undefined ||
    adminKey === undefined ||
    media.get("MEDIA_SERVICE_API_KEY") === undefined
  ) {
    return null;
  }

  return {
    platformUrl,
    adminKey,
    mediaUrl,
    signInUrl,
    musicPort: Number(musicPort),
    accountUrl,
    mediaEnv: Object.fromEntries(media),
  };
};
