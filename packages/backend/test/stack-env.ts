import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));

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

/** What the suite needs to reach the stack. */
export interface Stack {
  readonly convexUrl: string;
  readonly mediaServiceKey: string;
  readonly playbackTokenSecret: string;
}

/**
 * The stack to test, or undefined unless `MEDIA_STACK_TESTS=1` and a stack is configured. The
 * suite skips itself when this is undefined, so `pnpm test` stays green without Docker.
 */
export const findStack = (): Stack | undefined => {
  if (process.env["MEDIA_STACK_TESTS"] !== "1") return undefined;
  const backend = readEnvFile(join(backendDir, ".env.local"));
  const media = readEnvFile(join(backendDir, "../../apps/media/.env.local"));

  const convexUrl = pick("CONVEX_SELF_HOSTED_URL", backend);
  const mediaServiceKey = pick("MEDIA_SERVICE_API_KEY", media);
  const playbackTokenSecret = pick("PLAYBACK_TOKEN_SECRET", media);

  if (
    convexUrl === undefined ||
    mediaServiceKey === undefined ||
    playbackTokenSecret === undefined
  ) {
    throw new Error("MEDIA_STACK_TESTS=1 but no stack is configured; run scripts/dev-stack.sh up");
  }

  return { convexUrl, mediaServiceKey, playbackTokenSecret };
};

/** The stack's Convex admin key, for admin endpoints such as the function log. */
export const adminKey = (): string => {
  const key = pick("CONVEX_SELF_HOSTED_ADMIN_KEY", readEnvFile(join(backendDir, ".env.local")));

  if (key === undefined) throw new Error("No admin key; run scripts/dev-stack.sh up");

  return key;
};

/**
 * Appends documents to a table with `convex import`, the admin import path backups restore through.
 * The suite uses it to plant records it cannot wait for, such as a device code ten minutes old.
 */
export const importDocuments = (table: string, documents: ReadonlyArray<string>): void => {
  const directory = mkdtempSync(join(tmpdir(), "movies-import-"));
  const file = join(directory, `${table}.jsonl`);

  try {
    writeFileSync(file, `${documents.join("\n")}\n`);

    execFileSync(
      join(backendDir, "node_modules/.bin/convex"),
      ["import", "--table", table, "--append", "--yes", file],
      { cwd: backendDir, stdio: "ignore" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const isFunctionModule = (name: string): boolean =>
  !name.startsWith("lib_") && name !== "crons" && name !== "http";

/** The modules `convex/_generated/api.d.ts` declares, so a new file is found without a list. */
export const apiModules = (): ReadonlyArray<string> => {
  const declaration = readFileSync(join(backendDir, "convex/_generated/api.d.ts"), "utf8");
  const fullApi = declaration.slice(declaration.indexOf("declare const fullApi"));
  const body = fullApi.slice(0, fullApi.indexOf("}>"));

  return [...body.matchAll(/^\s+(\w+): typeof \w+;$/gmu)].flatMap(([, name]) =>
    name !== undefined && isFunctionModule(name) ? [name] : [],
  );
};

/**
 * One real document ID per table, read with the Convex CLI's admin access, so generated arguments
 * pass `v.id` validation and calls reach the function's own checks.
 */
export const sampleIds = (tables: Iterable<string>): ReadonlyMap<string, string> =>
  new Map(
    [...new Set(tables)].map((table) => {
      const listed = execFileSync(
        join(backendDir, "node_modules/.bin/convex"),
        ["data", table, "--limit", "1", "--format", "jsonl"],
        { cwd: backendDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );

      const sampled = /"_id":\s*"(?<id>[^"]+)"/u.exec(listed)?.groups?.["id"];

      if (sampled === undefined) throw new Error(`The ${table} table is empty; nothing to sample`);

      return [table, sampled] as const;
    }),
  );

/**
 * Runs an internal function without arguments, such as a cron's, with the Convex CLI's admin
 * access, so the suite can run scheduled upkeep now instead of waiting for its schedule. Returns
 * what the CLI printed: the function's result as JSON.
 */
export const runInternal = (path: string): string =>
  execFileSync(join(backendDir, "node_modules/.bin/convex"), ["run", path, "{}"], {
    cwd: backendDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Every document of a table as JSON lines, read with the Convex CLI's admin access. */
export const tableLines = (table: string): ReadonlyArray<string> =>
  execFileSync(
    join(backendDir, "node_modules/.bin/convex"),
    ["data", table, "--limit", "10000", "--format", "jsonl"],
    { cwd: backendDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\n")
    .filter((line) => line.trim().startsWith("{"));
