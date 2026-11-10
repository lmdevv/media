import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** The one module that writes the movies tables (ADR 0024). */
const WRITER = "packages/platform/convex/movies/write.ts";

const MOVIES_DIR = "packages/platform/convex/movies/";

/** The movies tables, which no module outside `movies/` writes either. */
const MOVIES_TABLES = new Set([
  "titles",
  "titleGenres",
  "seasons",
  "episodes",
  "people",
  "credits",
  "mediaFiles",
  "collections",
  "collectionItems",
  "watchProgress",
  "myList",
  "watchMarks",
]);

/** Core tables a module in `movies/` may insert into: the stack probe's libraries and grants. */
const CORE_INSERTS = new Set(["libraries", "grants"]);

const WRITES = new Set(["insert", "patch", "replace"]);

/** Whether `node` is a database: `db`, or a member named `db` such as `ctx.db`. */
const isDatabase = (node: ESTree.Node): boolean =>
  (node.type === "Identifier" && node.name === "db") ||
  (node.type === "MemberExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === "db");

/** The table a write names as its first argument, or null when it names none. */
const tableOf = (node: ESTree.CallExpression): string | null => {
  const [first] = node.arguments;

  return first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
};

/**
 * Route every insert, patch, and replace of a movies table through `movies/write.ts`, which fits
 * each document within the bound the reads reserve for it. In `movies/`, any write but an insert
 * into a core table is reported, since a patch or a replace names only an id; elsewhere, a write
 * that names a movies table is.
 */
export const moviesWriterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require movies-table writes to go through packages/platform/convex/movies/write.ts.",
    },
    messages: {
      direct:
        "Write movies tables through packages/platform/convex/movies/write.ts, which fits each document within the bound its reads reserve (ADR 0024).",
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    const inMovies = file.includes(MOVIES_DIR);

    if (file.endsWith(WRITER)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;

        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          !WRITES.has(callee.property.name) ||
          !isDatabase(callee.object)
        ) {
          return;
        }

        const table = tableOf(node);

        const direct = inMovies
          ? callee.property.name !== "insert" || table === null || !CORE_INSERTS.has(table)
          : table !== null && MOVIES_TABLES.has(table);

        if (direct) context.report({ node, messageId: "direct" });
      },
    };
  },
});
