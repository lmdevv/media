import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DIVIDER, REUSE_WINDOW_MS } from "../../../convex/core/auth/store";

const implementation = join(
  dirname(fileURLToPath(import.meta.resolve("@convex-dev/auth/server"))),
  "implementation",
);

const sourceOf = (file: string): string => readFileSync(join(implementation, file), "utf8");

describe("the core's auth store", () => {
  it("mirrors the reuse window and token divider of the installed Convex Auth", () => {
    expect(sourceOf("refreshTokens.js")).toContain(
      `export const REFRESH_TOKEN_REUSE_WINDOW_MS = ${REUSE_WINDOW_MS / 1000} * 1000;`,
    );
    expect(sourceOf("utils.js")).toContain(
      `export const REFRESH_TOKEN_DIVIDER = ${JSON.stringify(DIVIDER)};`,
    );
  });
});
