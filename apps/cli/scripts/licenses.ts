import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Metafile } from "esbuild";

import { decodePackageManifest } from "./package-manifest.ts";

const LICENSE_FILE = /^(?:licen[cs]e|notice|copying)/iu;

const packageDirectory = (input: string): string | undefined =>
  /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u.exec(input)?.[1];

const section = async (directory: string): Promise<string> => {
  const manifest = decodePackageManifest(await readFile(join(directory, "package.json"), "utf8"));

  const files = (await readdir(directory)).filter((name) => LICENSE_FILE.test(name)).toSorted();

  const texts = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));

  const body =
    texts.length > 0 ? texts.map((license) => license.trim()).join("\n\n") : "No license file.";

  return `## ${manifest.name} ${manifest.version} (${manifest.license ?? "no license field"})\n\n${body}\n`;
};

/** Software a bundle is built into besides its packages, such as the Node.js runtime. */
export interface Runtime {
  /** The section heading, such as `Node.js v24.22.1`. */
  readonly name: string;
  /** Its complete license text. */
  readonly license: string;
}

/**
 * Writes the licenses of `runtimes`, then of every package `metafile`'s inputs come from, to
 * `outfile`.
 */
export const writeThirdPartyLicenses = async (
  metafile: Metafile,
  outfile: string,
  runtimes: ReadonlyArray<Runtime> = [],
): Promise<void> => {
  const directories = new Set(
    Object.keys(metafile.inputs).flatMap((input) => {
      const directory = packageDirectory(input);

      return directory === undefined ? [] : [resolve(directory)];
    }),
  );

  const packages = await Promise.all([...directories].toSorted().map(section));

  const sections = [
    ...runtimes.map((runtime) => `## ${runtime.name}\n\n${runtime.license.trim()}\n`),
    ...packages,
  ];

  await writeFile(
    outfile,
    `# Third-party licenses\n\nThe \`media\` CLI bundles this software.\n\n${sections.join("\n")}`,
  );
};
