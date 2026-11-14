import { strict as effectStrict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

const commandOnly =
  "Declare a public function as a command in packages/commands and pass its handler to register from packages/platform/commands, or build a server function with serverQuery or serverMutation from convex/core/lib/serverFacing.ts.";

const genericBans = {
  paths: [
    {
      name: "convex/server",
      importNames: ["queryGeneric", "mutationGeneric", "actionGeneric"],
      message: commandOnly,
    },
  ],
};

const builderBans = {
  ...genericBans,
  patterns: [
    {
      regex: "_generated/server$",
      importNames: ["query", "mutation", "action"],
      message: commandOnly,
    },
  ],
};

const convexAuthBan = {
  regex: "^@convex-dev/auth",
  message:
    "Read the caller through requireCaller in convex/core/auth/caller.ts; only convex/auth.ts and convex/core/auth/ use Convex Auth.",
};

export default defineConfig({
  extends: [effectStrict],
  plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
  categories: { correctness: "error", suspicious: "error", perf: "error" },
  options: { typeAware: true, denyWarnings: true, reportUnusedDisableDirectives: "error" },
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    ".repos/**",
    "legacy/**",
    "tools/oxlint/**",
    "**/dist/**",
    "packages/platform/convex/_generated/**",
    "apps/web-movies/src/routeTree.gen.ts",
    "apps/web-account/src/routeTree.gen.ts",
    "apps/web-music/src/routeTree.gen.ts",
    "apps/mobile-movies/src/uniwind-types.d.ts",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    { name: "timmo-effect", specifier: "./tools/oxlint/timmo-effect/index.ts" },
    { name: "media", specifier: "./tools/oxlint/media/index.ts" },
  ],
  rules: {
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/ban-ts-comment": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/only-throw-error": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    "typescript/no-unnecessary-type-arguments": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/strict-boolean-expressions": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "typescript/prefer-nullish-coalescing": "error",
    "typescript/restrict-template-expressions": "error",
    "import/no-cycle": "error",
    // Convex names every document's system fields this way.
    "eslint/no-underscore-dangle": ["error", { allow: ["_id", "_creationTime"] }],
    "import/no-unassigned-import": ["error", { allow: ["**/*.css"] }],

    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",

    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/prefer-effect-match": "error",

    "timmo-effect/no-try-catch-in-effect-generators": "error",
    "timmo-effect/prefer-platform-services": "error",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
      rules: { "anti-slop-effect/no-manual-tagged-construction": "off" },
    },
    {
      files: ["packages/platform/convex/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          { ...builderBans, patterns: [...builderBans.patterns, convexAuthBan] },
        ],
      },
    },
    {
      files: ["packages/platform/convex/**"],
      rules: { "media/movies-writer": "error", "media/music-writer": "error" },
    },
    {
      files: ["packages/platform/convex/auth.ts", "packages/platform/convex/core/auth/**"],
      rules: { "no-restricted-imports": ["error", builderBans] },
    },
    {
      // The media-service guard: the only module in convex/ that builds public functions itself.
      files: ["packages/platform/convex/core/lib/serverFacing.ts"],
      rules: {
        "no-restricted-imports": ["error", { ...genericBans, patterns: [convexAuthBan] }],
      },
    },
  ],
});
