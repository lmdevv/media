#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly only?: (path: string) => boolean;
}

const under =
  (...prefixes: ReadonlyArray<string>) =>
  (path: string): boolean =>
    prefixes.some((prefix) => path === prefix || path.startsWith(prefix));

const history = under("legacy/", ".audit/", "docs/decisions/", "docs/spikes.md");

const regenerated = under("pnpm-lock.yaml", "scripts/rename-to-media.ts");

const musicNames = new Set([
  "MEDIA_CACHE_MAX_MB",
  "MEDIA_DATA_DIR",
  "MEDIA_PUBLIC_URL",
  "MEDIA_RESCAN_MINUTES",
  "MEDIA_SERVICE_SECRET",
]);

const settings: ReadonlyArray<readonly [string, string]> = [
  ["MOVIES_API_KEY", "MEDIA_API_KEY"],
  ["MOVIES_BIND", "MEDIA_BIND"],
  ["MOVIES_CONVEX_URL", "MEDIA_CONVEX_URL"],
  ["MOVIES_IMAGE", "MEDIA_IMAGE"],
  ["MOVIES_IMPORT_PASSWORD", "MEDIA_IMPORT_PASSWORD"],
  ["MOVIES_IMPORT_TOKEN", "MEDIA_IMPORT_TOKEN"],
  ["MOVIES_JELLYFIN_DOCKER", "MEDIA_JELLYFIN_DOCKER"],
  ["MOVIES_LIBRARY", "MEDIA_LIBRARY"],
  ["MOVIES_LIBRARY_ROOTS", "MEDIA_LIBRARY_ROOTS"],
  ["MOVIES_MEDIA_URL", "MEDIA_SERVER_URL"],
  ["MOVIES_PACKAGED_CONVEX_URL", "MEDIA_PACKAGED_CONVEX_URL"],
  ["MOVIES_PACKAGED_LIBRARY", "MEDIA_PACKAGED_LIBRARY"],
  ["MOVIES_PACKAGED_MEDIA_URL", "MEDIA_PACKAGED_SERVER_URL"],
  ["MOVIES_PACKAGED_RESTART", "MEDIA_PACKAGED_RESTART"],
  ["MOVIES_PACKAGED_STACK", "MEDIA_PACKAGED_STACK"],
  ["MOVIES_PASSWORD", "MEDIA_PASSWORD"],
  ["MOVIES_PORT", "MEDIA_PORT"],
  ["MOVIES_PORT_BASE", "MEDIA_PORT_BASE"],
  ["MOVIES_PROFILE", "MEDIA_PROFILE"],
  ["MOVIES_PUBLIC_URL", "MEDIA_BASE_URL"],
  ["MOVIES_READ_COSTS", "MEDIA_READ_COSTS"],
  ["MOVIES_STACK", "MEDIA_STACK"],
  ["MOVIES_STACK_TESTS", "MEDIA_STACK_TESTS"],
  ["MOVIES_TIMING", "MEDIA_TIMING"],
  ["MOVIES_TIMING_HARDWARE", "MEDIA_TIMING_HARDWARE"],
  ["MOVIES_TIMING_ONLY", "MEDIA_TIMING_ONLY"],
  ["MOVIES_TIMING_OUT", "MEDIA_TIMING_OUT"],
  ["MOVIES_TIMING_RUNS", "MEDIA_TIMING_RUNS"],
  ["MOVIES_TIMING_SOURCES", "MEDIA_TIMING_SOURCES"],
  ["MOVIES_VERIFY_BROWSER_NETWORK", "MEDIA_VERIFY_BROWSER_NETWORK"],
  ["MOVIES_VERIFY_RUN", "MEDIA_VERIFY_RUN"],
];

const anySetting = /(?<![A-Za-z0-9_])MOVIES_[A-Z0-9_]*[A-Z0-9](?![A-Za-z0-9_])/u;

const cliTopLevelCommands = [
  "account",
  "api-keys",
  "backup",
  "backups",
  "call",
  "collections",
  "commands",
  "continue",
  "device-auth",
  "diagnostics",
  "downloads",
  "history",
  "import",
  "invites",
  "jobs",
  "keys",
  "libraries",
  "login",
  "logout",
  "logs",
  "metadata",
  "migration",
  "my-list",
  "people",
  "play",
  "playback",
  "profiles",
  "progress",
  "restore",
  "rooms",
  "scan",
  "search",
  "sessions",
  "setup",
  "titles",
  "users",
  "whoami",
].join("|");

const rules: ReadonlyArray<Rule> = [
  { name: "server package", pattern: /@movies\/media(?![\w-])/gu, replacement: "@media/server" },
  { name: "scope", pattern: /@movies\//gu, replacement: "@media/" },
  {
    name: "scope folder",
    pattern: /node_modules\/@movies(?![\w./-])/gu,
    replacement: "node_modules/@media",
  },
  {
    name: "scope in a regex",
    pattern: /@movies\\\/\(backend\|media\)/gu,
    replacement: String.raw`@media\/(backend|server)`,
  },
  {
    name: "web placeholder",
    pattern: /__MOVIES_CONVEX_URL__/gu,
    replacement: "__MEDIA_CONVEX_URL__",
  },
  ...settings.map(([from, replacement]): Rule => ({
    name: "settings",
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_])${from}(?![A-Za-z0-9_])`, "gu"),
    replacement,
  })),
  { name: "settings", pattern: /`MOVIES_\*`/gu, replacement: "`MEDIA_*`" },
  {
    name: "image",
    pattern: /ghcr\.io\/lmdevv\/movies(?![\w-])/gu,
    replacement: "ghcr.io/lmdevv/media",
  },
  {
    name: "repo URL",
    pattern: /github\.com\/lmdevv\/movies(?![\w-])/gu,
    replacement: "github.com/lmdevv/media",
  },
  { name: "clone folder", pattern: /\bcd movies(?= &&|$)/gmu, replacement: "cd media" },
  {
    name: "flake URL",
    pattern: /github:lmdevv\/movies(?![\w-])/gu,
    replacement: "github:lmdevv/media",
  },
  {
    name: "NixOS options",
    pattern: /(?<![\w-]|systemd\.)services\.movies(?![\w-])/gu,
    replacement: "services.media",
  },
  {
    name: "CLI options",
    pattern: /(?<![\w-])programs\.movies(?![\w-])/gu,
    replacement: "programs.media",
  },
  {
    name: "CLI invocation",
    pattern: new RegExp(
      String.raw`(?<![\w[@./=$\\-])movies(?=\s+(?:(?:${cliTopLevelCommands})(?![\w-])|--help\b|--version\b|<(?:command|group|argv)>|\$\{))`,
      "gu",
    ),
    replacement: "media",
  },
  { name: "CLI usage", pattern: /Usage: movies(?![\w-])/gu, replacement: "Usage: media" },
  {
    name: "CLI name",
    pattern: /(?<![\w[@./-])(\\?`?)movies(\1)( |\n# )(CLI|executable)\b/gu,
    replacement: "$1media$2$3$4",
  },
  {
    name: "CLI in prose",
    pattern:
      /(?<=`)movies(?=` (?:runs|invocation|process|image|signing in)\b)|(?<=after `)movies(?=`)|(?<=the repository `)movies(?=`)/gu,
    replacement: "media",
  },
  {
    name: "CLI in the container",
    pattern: /exec movies movies\b/gu,
    replacement: "exec movies media",
  },
  { name: "CLI after settings", pattern: /(?<=_URL= )movies(?=\s)/gu, replacement: "media" },
  {
    name: "CLI tests",
    pattern:
      /(?<=the )movies(?= (?:command|binary)")|(?<![\w"'.-])movies(?=\()|(?<=const )movies(?= =)/gu,
    replacement: "media",
    only: under("apps/cli/src/"),
  },
  {
    name: "CLI error prefix",
    pattern: /(?<=["'`])movies: /gu,
    replacement: "media: ",
    only: under("apps/cli/"),
  },
  {
    name: "CLI synopsis",
    pattern: /\["movies", entry\.path/gu,
    replacement: '["media", entry.path',
  },
  { name: "CLI bundle", pattern: /dist\/movies\.js\b/gu, replacement: "dist/media.js" },
  { name: "CLI bundle path", pattern: /"dist", "movies\.js"/gu, replacement: '"dist", "media.js"' },
  {
    name: "CLI bin",
    pattern: /"movies": "dist\/media\.js"/gu,
    replacement: '"media": "dist/media.js"',
  },
  { name: "CLI in the image", pattern: /cli\/movies\.mjs\b/gu, replacement: "cli/media.mjs" },
  {
    name: "CLI on the image's PATH",
    pattern: /\/usr\/local\/bin\/movies\b/gu,
    replacement: "/usr/local/bin/media",
  },
  {
    name: "CLI binaries",
    pattern: /\bmovies-(?=(?:linux|darwin)-(?:x64|arm64)\b|<os>-<arch>)/gu,
    replacement: "media-",
  },
  {
    name: "CLI binary builds",
    pattern: /\bmovies(?=-\$\{|\.cjs\b|\.blob\b|-\*)/gu,
    replacement: "media",
    only: under("apps/cli/scripts/build-sea.ts", ".github/workflows/release.yml"),
  },
  {
    name: "CLI install",
    pattern: /~\/\.local\/bin\/movies\b/gu,
    replacement: "~/.local/bin/media",
  },
  {
    name: "Nix CLI package",
    pattern: /\$out\/lib\/movies\/movies\.mjs/gu,
    replacement: "$$out/lib/media/media.mjs",
    only: under("nix/cli.nix"),
  },
  {
    name: "Nix CLI package",
    pattern: /\$out\/bin\/movies\b/gu,
    replacement: "$$out/bin/media",
    only: under("nix/cli.nix"),
  },
  {
    name: "Nix CLI package",
    pattern: /mainProgram = "movies"/gu,
    replacement: 'mainProgram = "media"',
    only: under("nix/cli.nix"),
  },
];

const clashes = settings.filter(([, name]) => musicNames.has(name));

if (clashes.length > 0)
  throw new Error(`old music reads ${clashes.map(([, name]) => name).join(", ")}`);

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const files = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((line) => line.startsWith("100"))
  .map((line) => line.slice(line.indexOf("\t") + 1))
  .filter((path) => !history(path) && !regenerated(path));

const counts = new Map<string, number>();

const rewritten = new Map<string, string>();

for (const path of files) {
  const bytes = readFileSync(join(root, path));

  if (bytes.includes(0)) continue;

  const before = bytes.toString("utf8");
  let text = before;

  for (const rule of rules) {
    if (rule.only !== undefined && !rule.only(path)) continue;

    counts.set(rule.name, (counts.get(rule.name) ?? 0) + (text.match(rule.pattern)?.length ?? 0));
    text = text.replace(rule.pattern, rule.replacement);
  }

  const unknown = anySetting.exec(text);

  if (unknown !== null)
    throw new Error(`${path}: no new name for ${unknown[0]}; add it to settings`);

  if (text !== before) rewritten.set(path, text);
}

for (const [path, text] of rewritten) writeFileSync(join(root, path), text);

for (const [name, count] of counts) console.log(`${String(count).padStart(5)}  ${name}`);

console.log(`${rewritten.size} files changed`);

if (rewritten.size > 0) console.log("Now run pnpm install and pnpm fmt.");
