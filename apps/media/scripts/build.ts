import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build, type BuildOptions, context } from "esbuild";

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

await mkdir(new URL("../dist", import.meta.url), { recursive: true });

await writeFile(
  new URL("../dist/package.json", import.meta.url),
  `${JSON.stringify({ type: "module" })}\n`,
);

if (values.watch) {
  const builder = await context(options);

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
