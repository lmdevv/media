import { readFileSync } from "node:fs";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { savedAnswers, savedAnswersFileName } from "./saved-answers";
import type { CacheFile } from "./saved-answers";

const cacheFolder = () => {
  const files = new Map<string, string>();

  const cacheFile = (name: string): CacheFile => ({
    get exists() {
      return files.has(name);
    },
    text: async () => files.get(name) ?? "",
    write: async (text) => {
      files.set(name, text);
    },
    delete: () => {
      files.delete(name);
    },
  });

  return { files, cacheFile };
};

const options = (cacheFile: (name: string) => CacheFile, convexUrl: string) => ({
  cacheFile,
  convexUrl,
  release: "0.10.0",
  queries: ["movies.titles.home"],
});

describe("savedAnswers", () => {
  it("names each server's file apart, in letters, digits, dots, dashes, and underscores", () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.webUrl(), (a, b) => {
        expect(savedAnswersFileName(a)).toMatch(/^[\w.-]+$/u);
        expect(savedAnswersFileName(a) === savedAnswersFileName(b)).toBe(a === b);
      }),
    );
  });

  it("reads nothing before the first save, then the text saved, and nothing once removed", async () => {
    const { files, cacheFile } = cacheFolder();
    const { file } = savedAnswers(options(cacheFile, "http://cinema.home/convex"));

    const before = await file.read();

    await file.write("saved");
    const saved = await file.read();

    await file.remove();
    await file.remove();

    expect({ before, saved, after: await file.read(), left: files.size }).toStrictEqual({
      before: null,
      saved: "saved",
      after: null,
      left: 0,
    });
  });

  it("keeps two servers' answers in two files", async () => {
    const { files, cacheFile } = cacheFolder();

    await savedAnswers(options(cacheFile, "http://cinema.home/convex")).file.write("home");
    await savedAnswers(options(cacheFile, "http://cabin.home/convex")).file.write("cabin");

    expect([...files.values()].toSorted()).toStrictEqual(["cabin", "home"]);
  });

  it.each(["movies", "music"])(
    "relies on the %s app's default file protection, with no data-protection entitlement",
    (app) => {
      const config = readFileSync(new URL(`../../../apps/mobile/${app}/app.json`, import.meta.url));

      expect(config.toString()).not.toContain("com.apple.developer.default-data-protection");
    },
  );
});
