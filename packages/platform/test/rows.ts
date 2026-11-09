import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WithoutSystemFields } from "convex/server";

import type { Doc, TableNames } from "../convex/_generated/dataModel";

const platformDir = fileURLToPath(new URL("..", import.meta.url));

/** Room for thousands of rows of `convex data`; Node's 1 MB default cuts it off. */
const ROWS_OUTPUT_MAX = 64 * 1024 * 1024;

const convex = (args: ReadonlyArray<string>): string =>
  execFileSync(join(platformDir, "node_modules/.bin/convex"), args, {
    cwd: platformDir,
    encoding: "utf8",
    maxBuffer: ROWS_OUTPUT_MAX,
    stdio: ["ignore", "pipe", "ignore"],
  });

export const importRows = <Table extends TableNames>(
  table: Table,
  rows: ReadonlyArray<WithoutSystemFields<Doc<Table>>>,
): void => {
  const directory = mkdtempSync(join(tmpdir(), "media-import-"));
  const file = join(directory, `${table}.jsonl`);

  try {
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    convex(["import", "--table", table, "--append", "--yes", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const newestRows = (table: TableNames, limit = 200): ReadonlyArray<string> =>
  convex(["data", table, "--format", "jsonl", "--order", "desc", "--limit", String(limit)])
    .split("\n")
    .filter((line) => line.trim().startsWith("{"));
