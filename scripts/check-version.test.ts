import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("check-version.sh", import.meta.url));

/** Whether the script passes in a repository whose one package carries `version`. */
const passes = (version: string): boolean => {
  const root = mkdtempSync(join(tmpdir(), "check-version-"));

  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/platform"), { recursive: true });
    copyFileSync(script, join(root, "scripts/check-version.sh"));
    writeFileSync(join(root, "packages/platform/package.json"), JSON.stringify({ version }));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });

    return spawnSync(join(root, "scripts/check-version.sh"), { encoding: "utf8" }).status === 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// The same versions `Release` reads and refuses in packages/contracts/src/release.test.ts, so every
// version a release can carry is one the apps compare.
describe("check-version.sh", { timeout: 30_000 }, () => {
  it("passes a semantic version, pre-releases included", () => {
    for (const version of ["0.9.0", "0.10.0-rc.1", "1.0.0-alpha.beta", "1.0.0-x-y"]) {
      expect([version, passes(version)]).toEqual([version, true]);
    }
  });

  it("refuses a version the apps can't read as a release", () => {
    for (const version of [
      "0.9",
      "01.9.0",
      "0.9.0-",
      "0.9.0-rc 1",
      "0.9.0-rc.01",
      "0.9.0+build.1",
    ]) {
      expect([version, passes(version)]).toEqual([version, false]);
    }
  });
});
