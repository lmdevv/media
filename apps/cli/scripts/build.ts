import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";

import type { BuildOptions } from "esbuild";
import { build, context } from "esbuild";

import { writeThirdPartyLicenses } from "./licenses.ts";

const root = join(import.meta.dirname, "..");

const outfile = join(root, "dist", "media.js");

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
  // esbuild rewrites its outfile in place, so a CLI started while another build runs, as when two
  // test files build at once, could load half a file. Building beside it and renaming swaps the
  // whole file at once.
  const building = `${outfile}.${process.pid}.tmp`;
  const { metafile } = await build({ ...options, outfile: building, metafile: true });

  await chmod(building, 0o755);
  await rename(building, outfile);

  await writeThirdPartyLicenses(metafile, join(root, "dist", "THIRD_PARTY_LICENSES.md"));
}
