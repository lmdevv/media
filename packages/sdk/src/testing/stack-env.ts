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

/** What the real-stack suites need. */
export interface Stack {
  readonly convexUrl: string;
  readonly mediaServiceKey: string;
}

/**
 * The stack to test, or undefined unless `MEDIA_STACK_TESTS=1`, so `pnpm test` stays green
 * without Docker.
 *
 * @throws When `MEDIA_STACK_TESTS=1` but no stack is configured, a setup mistake.
 */
export const findStack = (): Stack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const backend = readEnvFile(join(repoRoot, "packages/backend/.env.local"));
  const media = readEnvFile(join(repoRoot, "apps/media/.env.local"));
  const convexUrl = process.env["CONVEX_SELF_HOSTED_URL"] ?? backend.get("CONVEX_SELF_HOSTED_URL");

  const mediaServiceKey =
    process.env["MEDIA_SERVICE_API_KEY"] ?? media.get("MEDIA_SERVICE_API_KEY");

  if (convexUrl === undefined || mediaServiceKey === undefined) {
    throw new Error("MEDIA_STACK_TESTS=1 but no stack is configured; run scripts/dev-stack.sh up");
  }

  return { convexUrl, mediaServiceKey };
};

/** What the platform stack suites need: the core deployment and its admin key. */
export interface PlatformStack {
  readonly url: string;
  readonly adminKey: string;
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

  if (url === undefined || adminKey === undefined) {
    throw new Error(
      "MEDIA_STACK_TESTS=1 but no core stack is configured; run scripts/dev-stack.sh up",
    );
  }

  return { url, adminKey };
};
