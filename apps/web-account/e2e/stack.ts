import { existsSync, readFileSync } from "node:fs";
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

/** The worktree's core, as `scripts/dev-stack.sh up` wrote it. */
export interface Stack {
  readonly platformUrl: string;
  readonly adminKey: string;
  readonly accountPort: number;
  /** The media server's address, which the admin pages call. */
  readonly mediaUrl: string;
  /** The stack's sign-in boundary (`scripts/dev-stack.sh`), where every sign-in goes. */
  readonly signInUrl: string;
}

/** The stack's settings, or null when this worktree has no stack. */
export const stackEnv = (): Stack | null => {
  const platform = readEnvFile(`${repoRoot}packages/platform/.env.local`);
  const account = readEnvFile(`${repoRoot}apps/web-account/.env.local`);
  const platformUrl = platform.get("CONVEX_SELF_HOSTED_URL");
  const adminKey = platform.get("CONVEX_SELF_HOSTED_ADMIN_KEY");
  const accountPort = account.get("ACCOUNT_PORT");
  const signInUrl = account.get("VITE_SIGN_IN_URL");

  if (
    platformUrl === undefined ||
    adminKey === undefined ||
    accountPort === undefined ||
    signInUrl === undefined
  ) {
    return null;
  }

  return {
    platformUrl,
    adminKey,
    accountPort: Number(accountPort),
    mediaUrl: account.get("VITE_MEDIA_BASE_URL") ?? "",
    signInUrl,
  };
};
