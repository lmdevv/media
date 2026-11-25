import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("ios-apps.sh", import.meta.url));

interface Scope {
  readonly bundle: ReadonlyArray<string>;
  readonly build: ReadonlyArray<string>;
}

// The two step-output lines the script prints for a scope.
const lines = ({ bundle, build }: Scope): string =>
  `bundle=${JSON.stringify(bundle)}\nbuild=${JSON.stringify(build)}\n`;

const scoped = (args: ReadonlyArray<string>, input = ""): string =>
  execFileSync(script, args, { input, encoding: "utf8" });

const scope = (...paths: ReadonlyArray<string>): string => scoped(["-"], paths.join("\n"));

const both = ["movies", "music"];

// Each case: a diff touching only this path, the apps CI bundles, and the apps it builds natively.
const cases: ReadonlyArray<readonly [string, Scope]> = [
  ["apps/web/movies/src/main.tsx", { bundle: [], build: [] }],
  ["apps/media/src/main.ts", { bundle: [], build: [] }],
  ["packages/mobile-core/src/sign-in.ts", { bundle: both, build: [] }],
  ["packages/sdk/src/index.ts", { bundle: both, build: [] }],
  ["apps/mobile/movies/src/app/_layout.tsx", { bundle: ["movies"], build: [] }],
  ["apps/mobile/music/src/global.css", { bundle: ["music"], build: [] }],
  [
    "apps/mobile/music/modules/vault-files/ios/VaultFilesModule.swift",
    { bundle: ["music"], build: ["music"] },
  ],
  ["pnpm-lock.yaml", { bundle: both, build: both }],
  [".github/workflows/ci.yml", { bundle: both, build: both }],
  ["docs/development.md", { bundle: [], build: [] }],
  ["packages/ui/src/styles/music.css", { bundle: ["music"], build: [] }],
  ["apps/mobile/music/app.json", { bundle: ["music"], build: ["music"] }],
  ["apps/mobile/movies/package.json", { bundle: ["movies"], build: ["movies"] }],
  ["pnpm-workspace.yaml", { bundle: both, build: both }],
  ["packages/mobile-core/ios/VaultFilesModule.swift", { bundle: both, build: both }],
  ["packages/player/ios/Player.podspec", { bundle: ["music"], build: ["music"] }],
  ["packages/mobile-core/src/native/Clock.swift", { bundle: both, build: both }],
  ["packages/mobile-core/src/native/expo-module.config.json", { bundle: both, build: both }],
  ["packages/mobile-core/package.json", { bundle: both, build: both }],
  ["packages/mobile-core/plugin/src/index.ts", { bundle: both, build: both }],
  [
    "apps/mobile/music/modules/vault-files/expo-module.config.json",
    { bundle: ["music"], build: ["music"] },
  ],
  ["apps/mobile/music/modules/vault-files/index.ts", { bundle: ["music"], build: ["music"] }],
  [
    "apps/mobile/movies/assets/fonts/InterTight-Bold.ttf",
    { bundle: ["movies"], build: ["movies"] },
  ],
  ["apps/mobile/movies/metro.config.js", { bundle: ["movies"], build: ["movies"] }],
  ["package.json", { bundle: both, build: both }],
  ["patches/react-native@0.88.0.patch", { bundle: both, build: both }],
  [".github/actions/ffmpeg/action.yml", { bundle: both, build: both }],
  ["scripts/ios-apps.sh", { bundle: both, build: both }],
  ["scripts/changed-packages.sh", { bundle: both, build: both }],
  ["tsconfig.json", { bundle: both, build: [] }],
  ["scripts/ios-apps.test.ts", { bundle: both, build: [] }],
  ["packages/config/tsconfig.base.json", { bundle: both, build: [] }],
];

// Each call starts the script, which runs changed-packages.sh twice, which each start turbo and node.
describe("ios-apps.sh", { timeout: 30_000 }, () => {
  it.each(cases)("scopes a diff only to %s", (path, expected) => {
    expect(scope(path)).toBe(lines(expected));
  });

  it("builds only for the paths that reach native code in a mixed diff", () => {
    expect(
      scope(
        "docs/development.md",
        "packages/mobile-core/src/sign-in.ts",
        "apps/mobile/music/modules/vault-files/ios/VaultFilesModule.swift",
      ),
    ).toBe(lines({ bundle: both, build: ["music"] }));
  });

  it("scopes nothing for an empty diff", () => {
    expect(scope()).toBe(lines({ bundle: [], build: [] }));
  });

  it("bundles and builds both apps for --all", () => {
    expect(scoped(["--all"])).toBe(lines({ bundle: both, build: both }));
  });
});
