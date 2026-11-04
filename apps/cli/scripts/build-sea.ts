import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { writeThirdPartyLicenses } from "./licenses.ts";

const root = join(import.meta.dirname, "..");

const out = join(root, "dist", "sea");

const main = join(out, "media.cjs");

const blob = join(out, "media.blob");

const config = join(out, "sea-config.json");

const executable = join(out, `media-${process.platform}-${process.arch}`);

const postject = fileURLToPath(import.meta.resolve("postject/dist/cli.js"));

const darwin = process.platform === "darwin";

const run = (command: string, args: ReadonlyArray<string>): void => {
  execFileSync(command, args, { stdio: "inherit" });
};

// The executable is a copy of node, so it carries Node.js and the libraries Node bundles (V8,
// OpenSSL, ICU, libuv, and more), whose licenses Node's LICENSE file collects. Node's release
// archives, which actions/setup-node installs, put it beside `bin/`. Other builds, such as
// nixpkgs', do not ship it: set NODE_LICENSE to the LICENSE of this Node version's source.
const nodeLicensePath =
  process.env["NODE_LICENSE"] ??
  join(dirname(dirname(await realpath(process.execPath))), "LICENSE");

const missingNodeLicense = `${nodeLicensePath} is not Node.js's LICENSE. Build with Node from nodejs.org (as the release workflow does), or set NODE_LICENSE to the LICENSE of Node ${process.version}.`;

const nodeLicense = await readFile(nodeLicensePath, "utf8").catch((cause: unknown) => {
  throw new Error(missingNodeLicense, { cause });
});

if (!nodeLicense.startsWith("Node.js is licensed for use as follows:")) {
  throw new Error(missingNodeLicense);
}

await rm(out, { recursive: true, force: true });

await mkdir(out, { recursive: true });

// Node 24 runs a single executable's entry point as CommonJS only.
const { metafile } = await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: main,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${process.versions.node}`,
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

await writeThirdPartyLicenses(metafile, join(out, "THIRD_PARTY_LICENSES.md"), [
  { name: `Node.js ${process.version}`, license: nodeLicense },
]);

await writeFile(
  config,
  JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }),
);

run(process.execPath, ["--experimental-sea-config", config]);

await copyFile(process.execPath, executable);

await chmod(executable, 0o755);

if (darwin) run("codesign", ["--remove-signature", executable]);

run(process.execPath, [
  postject,
  executable,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(darwin ? ["--macho-segment-name", "NODE_SEA"] : []),
]);

if (darwin) run("codesign", ["--sign", "-", executable]);
