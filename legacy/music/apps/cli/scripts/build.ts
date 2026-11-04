/**
 * Bundles the CLI into one executable file, `dist/music.js`, so it installs and runs without the
 * workspace. `--watch` rebuilds on change.
 */
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import type { BuildOptions } from "esbuild";
import { build, context } from "esbuild";

const root = join(import.meta.dirname, "..");

const outfile = join(root, "dist", "music.js");

const options: BuildOptions = {
  entryPoints: [join(root, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
};

if (process.argv.includes("--watch")) {
  const watcher = await context(options);

  await watcher.watch();
} else {
  await build(options);
  await chmod(outfile, 0o755);
}
