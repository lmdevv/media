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

/** What the real-stack suite needs. */
export interface Stack {
  readonly convexUrl: string;
  readonly mediaServiceKey: string;
}

/**
 * The stack to test, or undefined unless `MEDIA_STACK_TESTS=1`.
 *
 * @throws When `MEDIA_STACK_TESTS=1` but no stack is configured, a setup mistake.
 */
export const findStack = (): Stack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const backend = readEnvFile(join(repoRoot, "packages/backend/.env.local"));
  const convexUrl = process.env["CONVEX_SELF_HOSTED_URL"] ?? backend.get("CONVEX_SELF_HOSTED_URL");

  const mediaServiceKey =
    process.env["MEDIA_SERVICE_API_KEY"] ?? backend.get("MEDIA_SERVICE_API_KEY");

  if (convexUrl === undefined || mediaServiceKey === undefined) {
    throw new Error("MEDIA_STACK_TESTS=1 but no stack is configured; run scripts/dev-stack.sh up");
  }

  return { convexUrl, mediaServiceKey };
};

/** The core deployment of the stack: its URL and the env file holding its admin key. */
export interface CoreStack {
  readonly url: string;
  readonly envFile: string;
  /** The stack's sign-in boundary (`scripts/dev-stack.sh`), where every sign-in goes. */
  readonly signInUrl: string;
}

/**
 * The stack's core, or undefined unless `MEDIA_STACK_TESTS=1`.
 *
 * @throws When `MEDIA_STACK_TESTS=1` but no core is configured, a setup mistake.
 */
export const findCoreStack = (): CoreStack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const envFile = join(repoRoot, "packages/platform/.env.local");
  const file = readEnvFile(envFile);
  const url = file.get("CONVEX_SELF_HOSTED_URL");
  const signInUrl = file.get("MEDIA_SIGN_IN_URL");

  if (url === undefined || signInUrl === undefined) {
    throw new Error("MEDIA_STACK_TESTS=1 but no core is configured; run scripts/dev-stack.sh up");
  }

  return { url, envFile, signInUrl };
};
