/**
 * Bundles the media service into `dist/main.js`, a single ESM file that runs with `node`.
 *
 *   node scripts/build.ts           # one build
 *   node scripts/build.ts --watch   # rebuild on change and restart the service (`pnpm dev`)
 *
 * Watch mode runs the bundle with `node --watch --env-file-if-exists=.env.local`, so the dev
 * environment written by `scripts/dev-backend.sh` is loaded; production never reads that file.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build, context, type BuildOptions } from "esbuild";

const { values } = parseArgs({ options: { watch: { type: "boolean", default: false } } });

const root = fileURLToPath(new URL("..", import.meta.url));

const options: BuildOptions = {
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // Some CommonJS dependencies call `require` for Node built-ins, which an ESM bundle lacks.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};

// `dist/` stays runnable when copied on its own, for example into a container image.
await mkdir(new URL("../dist", import.meta.url), { recursive: true });

await writeFile(
  new URL("../dist/package.json", import.meta.url),
  `${JSON.stringify({ type: "module" })}\n`,
);

if (values.watch) {
  const builder = await context(options);

  // A broken first build is reported by esbuild; keep watching so the next save can fix it.
  await builder.rebuild().catch(() => undefined);
  await builder.watch();

  const service = spawn(
    process.execPath,
    ["--watch", "--env-file-if-exists=.env.local", "--enable-source-maps", "dist/main.js"],
    { cwd: root, stdio: "inherit" },
  );

  const stop = (): void => {
    service.kill("SIGTERM");
    void builder.dispose();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  await build(options);
}
