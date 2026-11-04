import { existsSync, readFileSync } from "node:fs";

export interface CoreStack {
  readonly url: string;
  readonly adminKey: string;
}

const envFile = new URL("../.env.local", import.meta.url);

const readEnvFile = (): ReadonlyMap<string, string> =>
  existsSync(envFile)
    ? new Map(
        readFileSync(envFile, "utf8")
          .split("\n")
          .flatMap((line) => {
            const separator = line.indexOf("=");

            return separator > 0
              ? [[line.slice(0, separator), line.slice(separator + 1)] as const]
              : [];
          }),
      )
    : new Map();

export const coreStackFromEnvFile = (): CoreStack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;

  const file = readEnvFile();
  const url = file.get("CONVEX_SELF_HOSTED_URL");
  const adminKey = file.get("CONVEX_SELF_HOSTED_ADMIN_KEY");

  if (url === undefined || adminKey === undefined) {
    throw new Error(
      "MEDIA_STACK_TESTS=1 but no core stack is configured; run scripts/dev-stack.sh up",
    );
  }

  return { url, adminKey };
};
