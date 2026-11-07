import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildCli } from "./process";

const packageRoot = join(import.meta.dirname, "..", "..");

const bundle = join(packageRoot, "dist", "media.js");

const build = () =>
  promisify(execFile)(process.execPath, [join(packageRoot, "scripts", "build.ts")]);

/** The size of each read of the bundle until `finished`, read after read. */
const readUntil = async (finished: () => boolean, sizes: Array<number>): Promise<Array<number>> => {
  if (finished()) return sizes;
  sizes.push((await readFile(bundle).catch(() => Buffer.alloc(0))).length);

  return readUntil(finished, sizes);
};

describe("building the CLI for stack tests", () => {
  it("swaps the bundle whole, so a run during another test file's build never loads half of it", async () => {
    buildCli();
    const whole = await readFile(bundle);
    let built = false;

    const builds = Promise.all([build(), build()]).finally(() => {
      built = true;
    });

    const sizes = await readUntil(() => built, []);

    await builds;

    expect(sizes.filter((size) => size !== whole.length)).toStrictEqual([]);
  }, 60_000);
});
