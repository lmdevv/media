import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("changed-packages.sh", import.meta.url));

const workspaces = (args: ReadonlyArray<string>, input = ""): ReadonlyArray<string> =>
  execFileSync(script, args, { input, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

const affected = (...paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  workspaces(["-"], paths.join("\n"));

const everyPackage = [
  "apps/cli",
  "apps/media",
  "apps/mobile",
  "apps/web-account",
  "apps/web-movies",
  "packages/backend",
  "packages/commands",
  "packages/config",
  "packages/contracts",
  "packages/platform",
  "packages/sdk",
  "packages/ui",
];

// Each call starts the script, two turbo processes, and node, which a loaded host can stretch past
// the default 5 s.
describe("changed-packages.sh", { timeout: 30_000 }, () => {
  it("affects nothing for a docs-only diff", () => {
    expect(affected("docs/operations.md", "README.md", "deploy/compose/README.md")).toEqual([]);
  });

  it("affects one app and nothing else when only that app changed", () => {
    expect(affected("apps/web-movies/src/main.tsx", "apps/web-movies/README.md")).toEqual([
      "apps/web-movies",
    ]);
  });

  it("affects a shared package and every package that depends on it", () => {
    expect(affected("packages/contracts/src/index.ts")).toEqual([
      "apps/cli",
      "apps/media",
      "apps/mobile",
      "apps/web-account",
      "apps/web-movies",
      "packages/backend",
      "packages/contracts",
      "packages/platform",
      "packages/sdk",
      "packages/ui",
    ]);
  });

  it("affects the root workspace and every package for a root config change", () => {
    expect(affected("tsconfig.json")).toEqual([".", ...everyPackage]);
    expect(affected("docs/operations.md", "pnpm-lock.yaml")).toEqual([".", ...everyPackage]);
  });

  it("keeps legacy/music apart from the root workspace", () => {
    expect(affected("legacy/music/apps/web/src/main.tsx")).toEqual(["legacy/music"]);
    expect(affected(".github/workflows/ci.yml")).toEqual([".", ...everyPackage, "legacy/music"]);
    expect(affected(".github/actions/ffmpeg/action.yml")).toEqual([
      ".",
      ...everyPackage,
      "legacy/music",
    ]);
  });

  it("routes the NixOS module to the media service and the dev stack to the backend", () => {
    expect(affected("nix/module.nix")).toEqual(["apps/media"]);
    expect(affected("scripts/dev-stack.sh")).toEqual(["packages/backend", "packages/platform"]);
    expect(affected("deploy/functions-hash.sh")).toEqual(["packages/backend"]);
  });

  it("lists every workspace for --all", () => {
    expect(workspaces(["--all"])).toEqual([".", ...everyPackage, "legacy/music"]);
  });
});
