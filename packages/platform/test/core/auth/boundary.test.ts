import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const convexRoot = fileURLToPath(new URL("../../../convex", import.meta.url));

const isInterface = (path: string): boolean => path === "auth.ts" || path.startsWith("core/auth/");

const sources = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) return entry.name === "_generated" ? [] : sources(path);

    return entry.name.endsWith(".ts") ? [path] : [];
  });

const READS_CALLER =
  /@convex-dev\/auth|getUserIdentity|getAuthUserId|getAuthSessionId|\bctx\.auth\b/u;

describe("the sign-in interface", () => {
  it("is the only core code that reads who is calling", () => {
    const outside = sources(convexRoot)
      .map((path) => relative(convexRoot, path))
      .filter((path) => !isInterface(path))
      .filter((path) => READS_CALLER.test(readFileSync(join(convexRoot, path), "utf8")));

    expect(outside).toEqual([]);
  });
});
