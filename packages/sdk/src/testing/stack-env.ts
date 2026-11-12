import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

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

/** What the platform stack suites need: the core deployment, its admin key, and the boundary. */
export interface PlatformStack {
  readonly url: string;
  readonly adminKey: string;
  /** The stack's sign-in boundary (`scripts/dev-stack.sh`), where every sign-in goes. */
  readonly signInUrl: string;
}

/**
 * The platform deployment of the stack to test, or undefined unless `MEDIA_STACK_TESTS=1`.
 *
 * @throws When `MEDIA_STACK_TESTS=1` but no core stack is configured, a setup mistake.
 */
export const findPlatformStack = (): PlatformStack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const platform = readEnvFile(join(repoRoot, "packages/platform/.env.local"));
  const url = platform.get("CONVEX_SELF_HOSTED_URL");
  const adminKey = platform.get("CONVEX_SELF_HOSTED_ADMIN_KEY");
  const signInUrl = platform.get("MEDIA_SIGN_IN_URL");

  if (url === undefined || adminKey === undefined || signInUrl === undefined) {
    throw new Error(
      "MEDIA_STACK_TESTS=1 but no core stack is configured; run scripts/dev-stack.sh up",
    );
  }

  return { url, adminKey, signInUrl };
};
