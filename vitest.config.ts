import { configDefaults, defineConfig } from "vitest/config";

const playback = "apps/media/src/playback/**/*.test.ts";

/**
 * The media service's playback tests take most of the suite's time, so CI runs them in a job of
 * their own with `--project playback` and the rest with `--project other`.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: "playback", include: [playback] } },
      {
        extends: true,
        test: {
          name: "other",
          include: [
            "{apps,packages}/*/src/**/*.test.{ts,tsx}",
            "packages/backend/test/**/*.test.ts",
            "packages/commands/test/**/*.test.ts",
            "packages/platform/test/**/*.test.ts",
            "scripts/*.test.ts",
            "tools/oxlint/media/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, playback],
        },
      },
    ],
  },
});
