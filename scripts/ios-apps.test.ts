import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ["apps/mobile/music/README.md", { bundle: ["music"], build: [] }],
  ["packages/sdk/README.md", { bundle: both, build: [] }],
  ["package.json", { bundle: both, build: both }],
  ["patches/react-native@0.88.0.patch", { bundle: both, build: both }],
  [".github/actions/ffmpeg/action.yml", { bundle: both, build: both }],
  ["scripts/ios-apps.sh", { bundle: both, build: both }],
  ["scripts/changed-packages.sh", { bundle: both, build: both }],
  ["tsconfig.json", { bundle: both, build: [] }],
  ["turbo.json", { bundle: both, build: [] }],
  ["tools/oxlint/media/rules/music-writer.ts", { bundle: both, build: [] }],
  ["scripts/ios-apps.test.ts", { bundle: both, build: [] }],
  ["packages/config/tsconfig.base.json", { bundle: both, build: [] }],
  ["packages/player/react-native.config.ts", { bundle: ["music"], build: ["music"] }],
  ["packages/mobile-core/app.plugin.ts", { bundle: both, build: both }],
];

/** The script's exit status and stderr in a repository whose one app holds `files`. */
const withApp = (files: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "ios-apps-"));

  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "apps/mobile/music"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ios-apps.sh"));

    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, "apps/mobile/music", name), text);
    }

    const { status, stderr } = spawnSync(join(root, "scripts/ios-apps.sh"), ["-"], {
      input: "",
      encoding: "utf8",
    });

    return { status, stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

type Plugin = string | readonly [string, Readonly<Record<string, never>>];

const withPlugins = (
  plugins: ReadonlyArray<Plugin | readonly [string, { fonts: ReadonlyArray<string> }]>,
) => withApp({ "app.json": JSON.stringify({ expo: { plugins } }) });

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

  it("fails for a config plugin that is not on its list, however it is named", () => {
    for (const plugin of [
      "./src/with-local-config.cjs",
      "/abs/apps/mobile/music/src/with-local-config.cjs",
      "@media/mobile-core",
      "@lmdevv/media",
      "expo-some-new-plugin",
    ]) {
      for (const entry of [plugin, [plugin, {}] as const] satisfies ReadonlyArray<Plugin>) {
        const { status, stderr } = withPlugins([
          "expo-router",
          ["expo-font", { fonts: [] }],
          entry,
        ]);

        expect([plugin, status]).toEqual([plugin, 1]);
        expect(stderr).toContain(`apps/mobile/music/app.json: the plugin "${plugin}"`);
      }
    }
  });

  it("fails for a dynamic app config, which can register any plugin", () => {
    for (const name of ["app.config.js", "app.config.ts"]) {
      const { status, stderr } = withApp({
        "app.json": JSON.stringify({ expo: { plugins: ["expo-router"] } }),
        [name]: "",
      });

      expect([name, status]).toEqual([name, 1]);
      expect(stderr).toContain(`apps/mobile/music/${name}: a dynamic config`);
    }
  });

  it("names a plugins entry that is not a list, and reads an app.json without one", () => {
    expect(withApp({ "app.json": '{"expo":{"plugins":{}}}' }).stderr).toContain(
      "apps/mobile/music/app.json: plugins is not a list",
    );

    // The config check passes these; the script then stops for want of changed-packages.sh here.
    for (const config of ["null", "{}", '{"expo":{"plugins":["expo-router"]}}']) {
      const { stderr } = withApp({ "app.json": config });

      expect([config, stderr.includes("an app config may run code")]).toEqual([config, false]);
      expect([config, stderr.includes("TypeError")]).toEqual([config, false]);
    }
  });

  it("scopes nothing for an empty diff", () => {
    expect(scope()).toBe(lines({ bundle: [], build: [] }));
  });

  it("bundles and builds both apps for --all", () => {
    expect(scoped(["--all"])).toBe(lines({ bundle: both, build: both }));
  });
});
