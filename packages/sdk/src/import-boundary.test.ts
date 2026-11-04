import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const root = import.meta.dirname;

const code = (path: string): string =>
  readFileSync(path, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^\s*\/\/.*$/gmu, "");

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path);

    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });

describe("SDK import boundary", () => {
  it("keeps Node built-ins and DOM globals out of shipped sources", () => {
    const offenders = sources(root).flatMap((path) => {
      const text = code(path);
      const nodeImport = /from "node:|require\("node:/u.test(text);
      const domGlobal = /\b(document|window|localStorage|HTMLVideoElement)\./u.test(text);

      return nodeImport || domGlobal ? [relative(root, path)] : [];
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps backend and media service code out of the SDK", () => {
    const offenders = sources(root).filter((path) =>
      /from "@media\/(backend|server)|convex\/_generated/u.test(code(path)),
    );

    expect(offenders).toStrictEqual([]);
  });
});
