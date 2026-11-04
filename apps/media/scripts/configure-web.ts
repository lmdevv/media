import { createHash } from "node:crypto";
import { chmod, cp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const PLACEHOLDER = "__MEDIA_CONVEX_URL__";

const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".map"]);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    "convex-url": { type: "string" },
  },
});

const { from, to, "convex-url": convexUrl } = values;

if (from === undefined || to === undefined || convexUrl === undefined) {
  process.stderr.write("usage: configure-web.ts --from <dist> --to <dir> --convex-url <url>\n");
  process.exit(2);
}

const url = new URL(convexUrl);

if (url.protocol !== "http:" && url.protocol !== "https:") {
  process.stderr.write(`configure-web: ${convexUrl} is not an http(s) URL\n`);
  process.exit(2);
}

const literal = JSON.stringify(convexUrl).slice(1, -1);

const suffix = createHash("sha256").update(convexUrl).digest("hex").slice(0, 8);

const listFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile() && TEXT.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
};

await rm(to, { recursive: true, force: true });

await cp(from, to, { recursive: true });

// A build in the Nix store is read-only, and copies keep its modes.
const copied = await readdir(to, { withFileTypes: true, recursive: true });

await chmod(to, 0o755);

await Promise.all(
  copied.map((entry) =>
    chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644),
  ),
);

const files = await listFiles(to);

const contents = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)),
);

const renames = new Map<string, string>();

for (const [file, text] of contents) {
  if (!text.includes(PLACEHOLDER)) continue;

  const extension = extname(file);
  const renamed = join(dirname(file), `${basename(file, extension)}-${suffix}${extension}`);

  contents.set(file, text.replaceAll(PLACEHOLDER, literal));
  renames.set(file, renamed);
}

if (renames.size === 0) {
  process.stderr.write(`configure-web: no file in ${from} holds ${PLACEHOLDER}\n`);
  process.exit(1);
}

const replacements = [...renames].map(
  ([file, renamed]) => [basename(file), basename(renamed)] as const,
);

await Promise.all(
  [...contents].map(async ([file, text]) => {
    const rewritten = replacements.reduce(
      (next, [old, renamed]) => next.replaceAll(old, renamed),
      text,
    );

    await writeFile(file, rewritten);
  }),
);

await Promise.all([...renames].map(([file, renamed]) => rename(file, renamed)));

process.stderr.write(
  `configure-web: ${[...renames.values()].map((file) => relative(to, file)).join(", ")} use ${convexUrl}\n`,
);
