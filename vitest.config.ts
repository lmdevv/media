import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: [
      "{apps,packages}/*/src/**/*.test.{ts,tsx}",
      "packages/backend/test/**/*.test.ts",
      "packages/commands/test/**/*.test.ts",
      "packages/platform/test/**/*.test.ts",
      "scripts/*.test.ts",
    ],
    passWithNoTests: true,
  },
});
