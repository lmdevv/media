#!/usr/bin/env node
/**
 * The mechanical half of moving the movies web client from old movies' Convex backend onto the
 * core: old command hooks become platform SDK calls, profile arguments go (D36), and imports
 * move to their new homes. What needs judgment, such as a list query becoming
 * paginated, a removed screen, or a command the core lacks, is left for a person; the script
 * names each unmapped command it meets.
 *
 * Usage:
 *
 *   node scripts/movies-codemod.ts [--check] [path ...]
 *
 * Each path is a file or a directory searched for `.ts` and `.tsx` files; the default is
 * `apps/web-movies/src`. `--check` prints what would change and writes nothing. Running it twice
 * changes nothing the second time.
 *
 * To see the mechanical diff on the tree before the cutover:
 *
 *   tree=$(mktemp -d) && git archive <pre-cutover commit> apps/web | tar -x -C "$tree"
 *   cp -r "$tree/apps/web/src" "$tree/before"
 *   node scripts/movies-codemod.ts "$tree/apps/web/src"
 *   git diff --no-index "$tree/before" "$tree/apps/web/src"
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Old movies command names and the platform SDK method each became. Commands missing here have no
 * platform command; the script leaves their calls in place and reports them.
 */
const COMMANDS = new Map([
  ["account.viewer", "core.auth.sessions.current"],
  ["apiKeys.create", "core.auth.apiKeys.create"],
  ["apiKeys.revoke", "core.auth.apiKeys.revoke"],
  ["backups.list", "core.server.backups.list"],
  ["backups.run", "core.server.backups.run"],
  ["collections.get", "movies.collections.get"],
  ["collections.list", "movies.collections.list"],
  ["deviceAuth.approve", "core.auth.deviceCodes.approve"],
  ["deviceAuth.deny", "core.auth.deviceCodes.deny"],
  ["deviceAuth.lookup", "core.auth.deviceCodes.lookup"],
  ["history.continueWatching", "movies.history.continueWatching"],
  ["history.list", "movies.history.list"],
  ["history.markUnwatched", "movies.history.markUnwatched"],
  ["history.markWatched", "movies.history.markWatched"],
  ["invites.create", "core.accounts.invites.create"],
  ["invites.list", "core.accounts.invites.list"],
  ["invites.lookup", "core.accounts.invites.lookup"],
  ["invites.revoke", "core.accounts.invites.revoke"],
  ["libraries.create", "core.libraries.create"],
  ["libraries.get", "core.libraries.get"],
  ["libraries.list", "core.libraries.list"],
  ["libraries.remove", "core.libraries.remove"],
  ["libraries.scan", "core.libraries.scan"],
  ["metadata.edit", "movies.metadata.edit"],
  ["metadata.fixMatch", "movies.metadata.match"],
  ["metadata.refresh", "movies.metadata.refresh"],
  ["migration.status", "movies.imports.list"],
  ["myList.add", "movies.myList.add"],
  ["myList.list", "movies.myList.list"],
  ["myList.remove", "movies.myList.remove"],
  ["people.get", "movies.people.get"],
  ["people.requestDetails", "movies.people.requestDetails"],
  ["people.search", "movies.people.search"],
  ["playback.progress", "movies.play.report"],
  ["playback.start", "movies.play.start"],
  ["sessions.revoke", "core.auth.sessions.revoke"],
  ["setup.status", "core.server.info"],
  ["titles.episodes", "movies.titles.episodes"],
  ["titles.genres", "movies.titles.genres"],
  ["titles.get", "movies.titles.get"],
  ["titles.home", "movies.titles.home"],
  ["titles.list", "movies.titles.list"],
  ["titles.nextEpisode", "movies.titles.nextEpisode"],
  ["titles.search", "movies.titles.search"],
  ["titles.similar", "movies.titles.similar"],
  ["titles.versions", "movies.titles.versions"],
  ["users.list", "core.accounts.users.list"],
  ["users.setRole", "core.accounts.users.setRole"],
]);

/** The old hooks, and how a call that the script could not map still reads. */
const OLD_HOOKS: ReadonlyMap<string, RegExp> = new Map([
  ["useCommand", /\buseCommand\(/u],
  ["useCommandQuery", /\buseCommandQuery\(/u],
]);

/** Catalog types the client now derives from the platform SDK in `@/lib/catalog`. */
const CATALOG_IDS = new Set(["CollectionId", "EpisodeId", "MediaFileId", "PersonId", "TitleId"]);

type Rule = readonly [pattern: RegExp, replacement: string];

/**
 * Profiles are gone (D36): every place a profile ID was read, passed, declared, or listed. Own
 * lines go first, so an argument on its own line leaves no blank line behind.
 */
const PROFILE_RULES: ReadonlyArray<Rule> = [
  [/\(\{ profileId \}: \{ readonly profileId: ProfileId \}\)/gu, "()"],
  [/^[ \t]*const \{ profile(?:, profiles)? \} = useActiveProfile\(\);\n/gmu, ""],
  [/^[ \t]*profileId=\{[^}\n]+\}\n/gmu, ""],
  [/ profileId=\{[^}\n]+\}/gu, ""],
  [/^[ \t]*(?:readonly )?profileId(?:: [\w.]+)?[,;]\n/gmu, ""],
  [/\{ profileId(?:: [\w.]+)? \}/gu, "{}"],
  [/\{ profileId(?:: [\w.]+)?, /gu, "{ "],
  [/, profileId(?:: [\w.]+)?(?= \})/gu, ""],
  [/\((?:profileId|profile\.id)(?:: ProfileId)?, /gu, "("],
  [/, (?:profileId|profile\.id)(?:: ProfileId)?\)/gu, ")"],
  [/\(profileId: ProfileId\)/gu, "()"],
  [/\[(?:profileId|profile\.id), /gu, "["],
  [/, (?:profileId|profile\.id)(?=[,\]])/gu, ""],
];

/** Scopes renamed on the core: old `manage` is `movies:edit` (ADR 0007). */
const SCOPE_RULES: ReadonlyArray<Rule> = [
  [/\.has\("manage"\)/gu, '.has("movies:edit")'],
  [/\.includes\("manage"\)/gu, '.includes("movies:edit")'],
];

/** Modules that moved. */
const MODULE_RULES: ReadonlyArray<Rule> = [
  [/from "@\/lib\/failure"/gu, 'from "@media/ui/lib/failure"'],
  [/from "@\/session\/viewer"/gu, 'from "@/session/session"'],
  [
    /^(import type \{[^}]*\} from )"@media\/contracts\/models\/(?:catalog|collections|people)";/gmu,
    '$1"@/lib/catalog";',
  ],
];

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** The names an import's braces list, in order. */
const namesIn = (list: string): ReadonlyArray<string> =>
  list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

/** Rewrites the braces of every import of `module` with `edit`; an emptied import goes. */
const editImport = (
  source: string,
  module: string,
  edit: (names: ReadonlyArray<string>, typeOnly: boolean) => ReadonlyArray<string>,
): string =>
  source.replace(
    new RegExp(`^import (type )?\\{([^}]*)\\} from "${module}";\\n`, "gmu"),
    (whole, type: string | undefined, list: string) => {
      const before = namesIn(list);
      const after = edit(before, type !== undefined);

      if (after.length === 0) return "";

      if (after.join() === before.join()) return whole;

      return `import ${type ?? ""}{ ${after.join(", ")} } from "${module}";\n`;
    },
  );

/** Joins every `import type` of `module` into the first one. */
const mergeTypeImports = (source: string, module: string): string => {
  const pattern = new RegExp(`^import type \\{([^}]*)\\} from "${module}";\\n`, "gmu");
  const names = [...source.matchAll(pattern)].flatMap((match) => namesIn(match[1] ?? ""));

  if (names.length === 0) return source;

  let first = true;

  return source.replace(pattern, () => {
    if (!first) return "";

    first = false;

    return `import type { ${[...new Set(names)].toSorted().join(", ")} } from "${module}";\n`;
  });
};

/** Adds `line` before the first import of an `@/` module, or after the last import. */
const addImport = (source: string, line: string): string => {
  const lines = source.split("\n");
  const local = lines.findIndex((each) => /^import .* from "@\//u.test(each));

  const last = lines.findLastIndex(
    (each) => /^import .*";$/u.test(each) || /^\} from ".*";$/u.test(each),
  );

  const at = local === -1 ? last + 1 : local;

  lines.splice(at, 0, line);

  return lines.join("\n");
};

/** IDs a route reads from its path, which `@/lib/catalog` brands without the old schemas. */
const ROUTE_IDS = ["Title", "Person", "Collection"] as const;

/**
 * Route params decoded with the old ID schemas, `Schema.decodeSync(TitleId)`, become the
 * catalog's brands, `asTitleId(raw.titleId)`.
 */
const routeIds = (source: string): string => {
  let code = source;

  for (const name of ROUTE_IDS) {
    const brand = `as${name}Id`;

    const decoder = new RegExp(
      `^const decode${name}Id = Schema\\.decodeSync\\(${name}Id\\);\\n\\n`,
      "mu",
    );

    if (!decoder.test(code)) continue;

    code = code.replace(decoder, "").replaceAll(`decode${name}Id(`, `${brand}(`);

    code = editImport(code, "@media/contracts/ids", (names, typeOnly) =>
      typeOnly ? names : names.filter((id) => id !== `${name}Id`),
    );

    code = addImport(code, `import { ${brand} } from "@/lib/catalog";`);
  }

  if (!/\bSchema\./u.test(code)) {
    code = editImport(code, "effect", (names, typeOnly) =>
      typeOnly ? names : names.filter((id) => id !== "Schema"),
    );
  }

  return code;
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A line that starts a component or a hook, where a hook call may go. */
const HOOK_HOST = /^\s*(?:export )?(?:function (?:use|[A-Z])\w*|const (?:use|[A-Z])\w* = )/u;

/**
 * The line where the body of the function starting at line `start` opens: the first `{` outside
 * its parameters, after the `=>` of an arrow function. -1 when the body does not end a line.
 */
const bodyStart = (lines: ReadonlyArray<string>, start: number): number => {
  const arrow = !/^\s*(?:export )?function /u.test(lines[start] ?? "");
  let depth = 0;
  let afterArrow = !arrow;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    for (let column = 0; column < line.length; column += 1) {
      const char = line[column];

      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if (depth === 0 && char === "=" && line[column + 1] === ">") afterArrow = true;
      else if (depth === 0 && afterArrow && char === "{") {
        return line.slice(column + 1).trim() === "" ? index : -1;
      }
    }
  }

  return -1;
};

/**
 * Puts `const platform = usePlatform();` at the top of each component or hook that reads
 * `platform.` and does not declare it yet.
 */
const declarePlatform = (source: string): string => {
  const lines = source.split("\n");
  const hosts = new Set<number>();

  for (const [index, line] of lines.entries()) {
    if (!/\bplatform\.(?:core|movies)\./u.test(line)) continue;

    for (let start = index; start >= 0; start -= 1) {
      const candidate = lines[start] ?? "";

      if (HOOK_HOST.test(candidate) && indentOf(candidate) < indentOf(line)) {
        hosts.add(start);
        break;
      }
    }
  }

  for (const start of [...hosts].toSorted((a, b) => b - a)) {
    const indent = indentOf(lines[start] ?? "");
    const open = bodyStart(lines, start);

    if (open === -1) continue;

    const close = lines.findIndex(
      (line, index) =>
        index > open && indentOf(line) === indent && line.trimStart().startsWith("}"),
    );

    const body = lines.slice(open + 1, close === -1 ? undefined : close);

    if (body.some((line) => /const platform = usePlatform\(\)/u.test(line))) continue;

    lines.splice(open + 1, 0, `${" ".repeat(indent + 2)}const platform = usePlatform();`);
  }

  return lines.join("\n");
};

/** What one file became, and the commands in it that need a person. */
export interface Transformed {
  readonly code: string;
  readonly unmapped: ReadonlyArray<string>;
}

/** Applies every mechanical rename to one module's source. */
export const transform = (source: string): Transformed => {
  const unmapped: Array<string> = [];

  const rename = (whole: string, name: string, index: number, platformCall: string): string => {
    const path = COMMANDS.get(name);

    if (path === undefined) {
      unmapped.push(`line ${lineOf(source, index)}: ${name}`);

      return whole;
    }

    return platformCall.replace("$PATH", path);
  };

  let code = source
    .replace(/useCommandQuery\(\s*"([\w.]+)"\s*,/gu, (whole, name: string, index: number) =>
      rename(whole, name, index, "usePlatformQuery(platform.$PATH,"),
    )
    .replace(/useCommand\(\s*"([\w.]+)"\s*\)/gu, (whole, name: string, index: number) =>
      rename(whole, name, index, "platform.$PATH"),
    );

  for (const [pattern, replacement] of [...PROFILE_RULES, ...SCOPE_RULES, ...MODULE_RULES]) {
    code = code.replace(pattern, replacement);
  }

  code = code.replace(/(usePlatformQuery\(\s*platform\.[\w.]+),\s*\{\}\s*\)/gu, "$1)");

  // `usePlatformQuery` takes `"skip"` in place of its arguments, not as one of their types.
  code = code
    .replace(
      /(usePlatformQuery\(\s*platform\.[\w.]+,\s*)([^?,()]+?) \? "skip" : (\{[^{}]*\})(,?\s*)\)/gu,
      "$1...orSkip($2 ? null : $3)$4)",
    )
    .replace(
      /(usePlatformQuery\(\s*platform\.[\w.]+,\s*)([^?,()]+?) \? (\{[^{}]*\}) : "skip"(,?\s*)\)/gu,
      "$1...orSkip($2 ? $3 : null)$4)",
    );

  if (code.includes("...orSkip(") && !/(?:import \{[^}]*|export const )\borSkip\b/u.test(code)) {
    code = addImport(code, 'import { orSkip } from "@/lib/query-state";');
  }

  code = routeIds(code);

  code = declarePlatform(code);

  const declares = code.includes("const platform = usePlatform()");
  const queries = code.includes("usePlatformQuery(");

  code = editImport(code, "@media/sdk/react", (names, typeOnly) => {
    if (typeOnly) return names;

    const kept = names.filter((name) => {
      const call = OLD_HOOKS.get(name);

      return call === undefined || call.test(code);
    });

    return [
      ...new Set([
        ...kept,
        ...(declares ? ["usePlatform"] : []),
        ...(queries ? ["usePlatformQuery"] : []),
      ]),
    ].toSorted();
  });

  code = editImport(code, "@media/contracts/ids", (names, typeOnly) =>
    names.filter((name) => name !== "ProfileId" || !typeOnly),
  ).replace(
    /^(import type \{([^}]*)\} from )"@media\/contracts\/ids";/gmu,
    (whole: string, head: string, list: string) =>
      namesIn(list).every((name) => CATALOG_IDS.has(name)) ? `${head}"@/lib/catalog";` : whole,
  );

  code = mergeTypeImports(code, "@/lib/catalog");

  code = editImport(code, "@/session/guards", (names) =>
    names.filter((name) => name !== "useActiveProfile"),
  );

  return { code: code.replace(/^\n+/u, ""), unmapped };
};

const sourcesUnder = (path: string): ReadonlyArray<string> => {
  if (!statSync(path).isDirectory()) return [path];

  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/u.test(file) && !file.endsWith(".gen.ts"))
    .map((file) => join(path, file))
    .toSorted();
};

const main = (args: ReadonlyArray<string>): void => {
  const check = args.includes("--check");
  const paths = args.filter((arg) => arg !== "--check");
  const files = (paths.length === 0 ? ["apps/web-movies/src"] : paths).flatMap(sourcesUnder);
  let changed = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const { code, unmapped } = transform(source);

    for (const note of unmapped) console.log(`${file} ${note} has no platform command`);

    if (code === source) continue;

    changed += 1;
    console.log(`${check ? "would change" : "changed"} ${file}`);

    if (!check) writeFileSync(file, code);
  }

  console.log(`${changed} of ${files.length} files ${check ? "would change" : "changed"}`);
};

if (import.meta.main) main(process.argv.slice(2));
